/* Account Tracker
 *
 * This module is responsible for tracking any number of accounts
 * and caching their current balances & transaction counts.
 *
 * It also tracks transaction hashes, and checks their inclusion status
 * on each new block.
 */

import EthQuery from '@metamask/eth-query';
import { v4 as random } from 'uuid';

import { ObservableStore } from '@metamask/obs-store';
import log from 'loglevel';
import pify from 'pify';
import { Web3Provider } from '@ethersproject/providers';
import { Contract } from '@ethersproject/contracts';
import SINGLE_CALL_BALANCES_ABI from 'single-call-balance-checker-abi';
import { LOCALHOST_RPC_URL } from '../../../shared/constants/network';

import { SINGLE_CALL_BALANCES_ADDRESSES } from '../constants/contracts';
import { previousValueComparator } from './util';

/**
 * This module is responsible for tracking any number of accounts and caching their current balances & transaction
 * counts.
 *
 * It also tracks transaction hashes, and checks their inclusion status on each new block.
 *
 * @typedef {object} AccountTracker
 * @property {object} store The stored object containing all accounts to track, as well as the current block's gas limit.
 * @property {object} store.accounts The accounts currently stored in this AccountTracker
 * @property {object} store.accountsByChain The accounts currently stored in this AccountTracker keyed by chain id
 * @property {string} store.currentBlockGasLimit A hex string indicating the gas limit of the current block
 * @property {string} store.currentBlockGasLimitByChain A hex string indicating the gas limit of the current block keyed by chain id
 * @property {object} _provider A provider needed to create the EthQuery instance used within this AccountTracker.
 * @property {EthQuery} _query An EthQuery instance used to access account information from the blockchain
 * @property {BlockTracker} _blockTracker A BlockTracker instance. Needed to ensure that accounts and their info updates
 * when a new block is created.
 * @property {object} _currentBlockNumberByChainId Reference to a property on the _blockTracker: the number (i.e. an id) of the the current block keyed by chain id
 */
export default class AccountTracker {
  /**
   * @param {object} opts - Options for initializing the controller
   * @param {object} opts.provider - An EIP-1193 provider instance that uses the current global network
   * @param {object} opts.blockTracker - A block tracker, which emits events for each new block
   * @param {Function} opts.getCurrentChainId - A function that returns the `chainId` for the current global network
   * @param {Function} opts.getNetworkIdentifier - A function that returns the current network
   * @param {Function} opts.onAccountRemoved - Allows subscribing to keyring controller accountRemoved event
   */
  #pollingTokenSets = new Map();

  #listeners = {};

  constructor(opts = {}) {
    const initState = {
      accounts: {},
      currentBlockGasLimit: '',
      accountsByChainId: {},
      currentBlockGasLimitByChainId: {},
    };
    this.store = new ObservableStore({ ...initState, ...opts.initState });

    this.resetState = () => {
      this.store.updateState(initState);
    };

    this._provider = opts.provider;
    this._blockTracker = opts.blockTracker;

    // bind function for easier listener syntax
    this._updateForBlock = this._updateForBlock.bind(this);
    this.getCurrentChainId = opts.getCurrentChainId;
    this.getNetworkClientById = opts.getNetworkClientById;
    this.getNetworkIdentifier = opts.getNetworkIdentifier;
    this.preferencesController = opts.preferencesController;
    this.onboardingController = opts.onboardingController;

    // blockTracker.currentBlock may be null
    const currentChainId = this.getCurrentChainId();
    this._currentBlockNumberByChainId = {
      [currentChainId]: this._blockTracker.getCurrentBlock(),
    };
    this._blockTracker.once('latest', (blockNumber) => {
      this._currentBlockNumberByChainId[currentChainId] = blockNumber;
    });

    // subscribe to account removal
    opts.onAccountRemoved((address) => this.removeAccounts([address]));

    this.onboardingController.store.subscribe(
      previousValueComparator(async (prevState, currState) => {
        const { completedOnboarding: prevCompletedOnboarding } = prevState;
        const { completedOnboarding: currCompletedOnboarding } = currState;
        if (!prevCompletedOnboarding && currCompletedOnboarding) {
          this._updateAccounts();
        }
      }, this.onboardingController.store.getState()),
    );

    this.preferencesController.store.subscribe(
      previousValueComparator(async (prevState, currState) => {
        const { selectedAddress: prevSelectedAddress } = prevState;
        const {
          selectedAddress: currSelectedAddress,
          useMultiAccountBalanceChecker,
        } = currState;
        if (
          prevSelectedAddress !== currSelectedAddress &&
          !useMultiAccountBalanceChecker
        ) {
          this._updateAccounts();
        }
      }, this.onboardingController.store.getState()),
    );
  }

  start() {
    // public
    // remove first to avoid double add
    this.stop();
    // add listener
    this._blockTracker.addListener('latest', this._updateForBlock);
    // fetch account balances
    this._updateAccountsWithNetworkClientId();
  }

  stop() {
    // public
    // remove listener
    this._blockTracker.removeListener('latest', this._updateForBlock);
  }

  getCorrectNetworkClient(networkClientId) {
    if (networkClientId) {
      const networkClient = this.getNetworkClientById(networkClientId);

      return {
        chainId: networkClient.configuration.chainId,
        provider: networkClient.provider,
        blockTracker: networkClient.blockNumber,
        identifier: this.getNetworkIdentifier(networkClient.configuration),
      };
    }
    return {
      chainId: this.getCurrentChainId(),
      provider: this._provider,
      blockTracker: this._blockTracker,
      indentifier: this.getNetworkIdentifier(),
    };
  }

  startPollingByNetworkClientId(networkClientId) {
    const pollToken = random();

    const pollingTokenSet = this.#pollingTokenSets.get(networkClientId);
    if (pollingTokenSet) {
      pollingTokenSet.add(pollToken);
    } else {
      const set = new Set();
      set.add(pollToken);
      this.#pollingTokenSets.set(networkClientId, set);
      this.subscribeWithNetworkClientId(networkClientId);
    }
    return pollToken;
  }

  /**
   * Stops polling for all networkClientIds
   */
  stopAllPolling() {
    this.stop();
    this.#pollingTokenSets.forEach((tokenSet, _networkClientId) => {
      tokenSet.forEach((token) => {
        this.stopPollingByPollingToken(token);
      });
    });
  }

  /**
   * Stops polling for a networkClientId
   *
   * @param pollingToken - The polling token to stop polling for
   */
  stopPollingByPollingToken(pollingToken) {
    if (!pollingToken) {
      throw new Error('pollingToken required');
    }
    let found = false;
    this.#pollingTokenSets.forEach((tokenSet, key) => {
      if (tokenSet.has(pollingToken)) {
        found = true;
        tokenSet.delete(pollingToken);
        if (tokenSet.size === 0) {
          this.#pollingTokenSets.delete(key);
          this.unsubscribeWithNetworkClientId(key);
        }
      }
    });
    if (!found) {
      throw new Error('pollingToken not found');
    }
  }

  subscribeWithNetworkClientId(networkClientId) {
    if (this.#listeners[networkClientId]) {
      return;
    }
    const { blockTracker } = this.getCorrectNetworkClient(networkClientId);
    const _updateForBlock = this._updateForBlock.bind(networkClientId);
    blockTracker.addListener('latest', _updateForBlock);

    this.#listeners[networkClientId] = _updateForBlock;

    this._updateAccountsWithNetworkClientId(networkClientId);
  }

  unsubscribeWithNetworkClientId(networkClientId) {
    if (!this.#listeners[networkClientId]) {
      return;
    }
    const { blockTracker } = this.getCorrectNetworkClient(networkClientId);
    blockTracker.removeListener('latest', this.#listeners[networkClientId]);

    delete this.#listeners[networkClientId];
  }

  /**
   * Ensures that the locally stored accounts are in sync with a set of accounts stored externally to this
   * AccountTracker.
   *
   * Once this AccountTracker's accounts are up to date with those referenced by the passed addresses, each
   * of these accounts are given an updated balance via EthQuery.
   *
   * @param {Array} addresses - The array of hex addresses for accounts with which this AccountTracker's accounts should be
   * in sync
   */
  syncWithAddresses(addresses) {
    // public
    const { accounts } = this.store.getState();
    const locals = Object.keys(accounts);

    const accountsToAdd = [];
    addresses.forEach((upstream) => {
      if (!locals.includes(upstream)) {
        accountsToAdd.push(upstream);
      }
    });

    const accountsToRemove = [];
    locals.forEach((local) => {
      if (!addresses.includes(local)) {
        accountsToRemove.push(local);
      }
    });

    this.addAccounts(accountsToAdd);
    this.removeAccounts(accountsToRemove);
  }

  /**
   * Adds new addresses to track the balances of
   * given a balance as long this._currentBlockNumberByChainId is defined for the chainId.
   *
   * @param {Array} addresses - An array of hex addresses of new accounts to track
   */
  addAccounts(addresses) {
    // private
    const { accounts, accountsByChainId } = this.store.getState();

    // add initial state for addresses
    addresses.forEach((address) => {
      accounts[address] = {};
    });
    Object.keys(accountsByChainId).forEach((chainId) => {
      addresses.forEach((address) => {
        accountsByChainId[chainId][address] = {};
      });
    });
    // save accounts state
    this.store.updateState({ accounts, accountsByChainId });

    // fetch balances for the accounts if there is block number ready
    if (this._currentBlockNumberByChainId[this.getCurrentChainId()]) {
      this._updateAccountsWithNetworkClientId();
    }
    this.#pollingTokenSets.forEach((_tokenSet, networkClientId) => {
      const { chainId } = this.getCorrectNetworkClient(networkClientId);
      if (this._currentBlockNumberByChainId[chainId]) {
        this._updateAccountsWithNetworkClientId(networkClientId);
      }
    });
  }

  /**
   * Removes accounts from being tracked
   *
   * @param {Array} addresses - An array of hex addresses to stop tracking.
   */
  removeAccounts(addresses) {
    // private
    const { accounts, accountsByChainId } = this.store.getState();

    // remove each state object
    addresses.forEach((address) => {
      delete accounts[address];
    });
    Object.keys(accountsByChainId).forEach((chainId) => {
      addresses.forEach((address) => {
        delete accountsByChainId[chainId][address];
      });
    });
    // save accounts state
    this.store.updateState({ accounts, accountsByChainId });
  }

  /**
   * Removes all addresses and associated balances
   */

  clearAccounts() {
    // public
    const { accountsByChainId } = this.store.getState();
    Object.keys(accountsByChainId).forEach((chainId) => {
      accountsByChainId[chainId] = {};
    });
    this.store.updateState({ accounts: {}, accountsByChainId });
  }

  /**
   * Given a block, updates this AccountTracker's currentBlockGasLimit, and then updates each local account's balance
   * via EthQuery
   *
   * @private
   * @param {number} blockNumber - the block number to update to.
   * @fires 'block' The updated state, if all account updates are successful
   */
  async _updateForBlock(blockNumber) {
    // private
    this._updateForBlockByChainId(null, blockNumber);
  }

  async _updateForBlockByChainId(networkClientId, blockNumber) {
    // private
    const { chainId, provider } = this.getCorrectNetworkClient(networkClientId);
    this._currentBlockNumberByChainId[chainId] = blockNumber;

    // block gasLimit polling shouldn't be in account-tracker shouldn't be here...
    const currentBlock = await pify(new EthQuery(provider)).getBlockByNumber(
      blockNumber,
      false,
    );
    if (!currentBlock) {
      return;
    }
    const currentBlockGasLimit = currentBlock.gasLimit;
    const { currentBlockGasLimitByChainId } = this.store.getState();
    currentBlockGasLimitByChainId[chainId] = currentBlockGasLimit;
    this.store.updateState({ currentBlockGasLimitByChainId });
    if (chainId === this.getCurrentChainId()) {
      this.store.updateState({
        currentBlockGasLimit,
      });
    }

    try {
      await this._updateAccountsWithNetworkClientId(networkClientId);
    } catch (err) {
      log.error(err);
    }
  }

  async _updateAccounts() {
    this._updateAccountsWithNetworkClientId();
    this.#pollingTokenSets.forEach((_tokenSet, networkClientId) => {
      this._updateAccountsWithNetworkClientId(networkClientId);
    });
  }

  /**
   * balanceChecker is deployed on main eth (test)nets and requires a single call
   * for all other networks, calls this._updateAccount for each account in this.store
   *
   * @param networkClientId
   * @returns {Promise} after all account balances updated
   */
  async _updateAccountsWithNetworkClientId(networkClientId) {
    // public
    const { completedOnboarding } = this.onboardingController.store.getState();
    if (!completedOnboarding) {
      return;
    }

    const { chainId, provider, identifier } =
      this.getCorrectNetworkClient(networkClientId);
    const { useMultiAccountBalanceChecker } =
      this.preferencesController.store.getState();

    let addresses = [];
    if (useMultiAccountBalanceChecker) {
      const { accountsByChainId } = this.store.getState();
      const accounts = accountsByChainId[chainId];

      addresses = Object.keys(accounts);
    } else {
      const selectedAddress = this.preferencesController.getSelectedAddress();

      addresses = [selectedAddress];
    }

    const rpcUrl = 'http://127.0.0.1:8545';
    const singleCallBalancesAddress = SINGLE_CALL_BALANCES_ADDRESSES[chainId];
    if (
      identifier === LOCALHOST_RPC_URL ||
      identifier === rpcUrl ||
      !singleCallBalancesAddress
    ) {
      await Promise.all(
        addresses.map((address) =>
          this._updateAccount(address, provider, chainId),
        ),
      );
    } else {
      await this._updateAccountsViaBalanceChecker(
        addresses,
        singleCallBalancesAddress,
        provider,
        chainId,
      );
    }
  }

  /**
   * Updates the current balance of an account.
   *
   * @private
   * @param {string} address - A hex address of a the account to be updated
   * @returns {Promise} after the account balance is updated
   */

  async _updateAccount(address, provider, chainId) {
    // private
    const { useMultiAccountBalanceChecker } =
      this.preferencesController.store.getState();

    let balance = '0x0';

    // query balance
    try {
      balance = await pify(new EthQuery(provider)).getBalance(address);
    } catch (error) {
      if (error.data?.request?.method !== 'eth_getBalance') {
        throw error;
      }
    }

    const result = { address, balance };
    // update accounts state
    const { accountsByChainId } = this.store.getState();
    const accounts = accountsByChainId[chainId];
    // only populate if the entry is still present
    if (!accounts[address]) {
      return;
    }

    let newAccounts = accounts;
    if (!useMultiAccountBalanceChecker) {
      newAccounts = {};
      Object.keys(accounts).forEach((accountAddress) => {
        if (address !== accountAddress) {
          newAccounts[accountAddress] = {
            address: accountAddress,
            balance: null,
          };
        }
      });
    }

    newAccounts[address] = result;

    accountsByChainId[chainId] = newAccounts;
    this.store.updateState({
      accountsByChainId,
    });
    if (chainId === this.getCurrentChainId()) {
      this.store.updateState({ accounts: newAccounts });
    }
  }

  /**
   * Updates current address balances from balanceChecker deployed contract instance
   *
   * @param {*} addresses
   * @param {*} deployedContractAddress
   * @param provider
   * @param chainId
   */
  async _updateAccountsViaBalanceChecker(
    addresses,
    deployedContractAddress,
    provider,
    chainId,
  ) {
    // private
    const { accountsByChainId } = this.store.getState();
    const accounts = accountsByChainId[chainId];

    const newAccounts = {};
    Object.keys(accounts).forEach((address) => {
      if (!addresses.includes(address)) {
        newAccounts[address] = { address, balance: null };
      }
    });

    const ethContract = await new Contract(
      deployedContractAddress,
      SINGLE_CALL_BALANCES_ABI,
      new Web3Provider(provider),
    );
    const ethBalance = ['0x0000000000000000000000000000000000000000'];

    try {
      const balances = await ethContract.balances(addresses, ethBalance);

      addresses.forEach((address, index) => {
        const balance = balances[index] ? balances[index].toHexString() : '0x0';
        newAccounts[address] = { address, balance };
      });

      accountsByChainId[chainId] = newAccounts;
      this.store.updateState({ accountsByChainId });
      if (chainId === this.getCurrentChainId()) {
        this.store.updateState({ accounts: newAccounts });
      }
    } catch (error) {
      log.warn(
        `MetaMask - Account Tracker single call balance fetch failed`,
        error,
      );
      Promise.all(
        addresses.map((address) =>
          this._updateAccount(address, provider, chainId),
        ),
      );
    }
  }
}
