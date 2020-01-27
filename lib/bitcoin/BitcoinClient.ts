import * as httpStatus from 'http-status';
import BitcoinBlockModel from './models/BitcoinBlockModel';
import BitcoinInputModel from './models/BitcoinInputModel';
import BitcoinOutputModel from './models/BitcoinOutputModel';
import BitcoinTransactionModel from './models/BitcoinTransactionModel';
import IBitcoinClient from './interfaces/IBitcoinClient';
import nodeFetch, { FetchError, Response, RequestInit } from 'node-fetch';
import ReadableStream from '../common/ReadableStream';
import { Address, Networks, PrivateKey, Script, Transaction, crypto, PublicKey, HDPrivateKey } from 'bitcore-lib';
import { IBlockInfo } from './BitcoinProcessor';

/**
 * Encapsulates functionality for reading/writing to the bitcoin ledger.
 */
export default class BitcoinClient implements IBitcoinClient {

  /** Bitcoin peer's RPC basic authorization credentials */
  private readonly bitcoinAuthorization?: string;

  /** Wallet private key */
  private readonly privateKey: PrivateKey;
  private readonly privateKeyAddress: Address;

  constructor (
    private bitcoinPeerUri: string,
    bitcoinRpcUsername: string | undefined,
    bitcoinRpcPassword: string | undefined,
    bitcoinWalletImportString: string,
    private requestTimeout: number,
    private requestMaxRetries: number) {

    // Bitcore has a type file error on PrivateKey
    try {
      this.privateKey = (PrivateKey as any).fromWIF(bitcoinWalletImportString);
    } catch (error) {
      throw new Error(`Failed creating private key from '${bitcoinWalletImportString}': ${error.message}`);
    }

    this.privateKeyAddress = this.privateKey.toAddress();

    if (bitcoinRpcUsername && bitcoinRpcPassword) {
      this.bitcoinAuthorization = Buffer.from(`${bitcoinRpcUsername}:${bitcoinRpcPassword}`).toString('base64');
    }
  }

  public async initialize (): Promise<void> {

    console.debug(`Checking if bitcoin contains a wallet for ${this.privateKeyAddress}`);
    if (!await this.isAddressAddedToWallet(this.privateKeyAddress.toString())) {
      console.debug(`Configuring bitcoin peer to watch address ${this.privateKeyAddress}. This can take up to 10 minutes.`);

      const publicKeyAsHex = this.privateKey.toPublicKey().toBuffer().toString('hex');
      await this.addWatchOnlyAddressToWallet(publicKeyAsHex, true);
    } else {
      console.debug('Wallet found.');
    }
  }

  /**
   * generates a private key in WIF format
   * @param network Which bitcoin network to generate this key for
   */
  public static generatePrivateKey (network: 'mainnet' | 'livenet' | 'testnet' | undefined): string {
    let bitcoreNetwork: Networks.Network | undefined;
    switch (network) {
      case 'mainnet':
        bitcoreNetwork = Networks.mainnet;
        break;
      case 'livenet':
        bitcoreNetwork = Networks.livenet;
        break;
      case 'testnet':
        bitcoreNetwork = Networks.testnet;
        break;
    }
    return new PrivateKey(undefined, bitcoreNetwork).toWIF();
  }

  public async broadcastTransaction (transactionData: string, feeInSatoshis: number): Promise<string> {

    const transaction = await this.createBitcoreTransaction(transactionData, feeInSatoshis);
    const rawTransaction = transaction.serialize();

    // console.info(`Broadcasting transaction ${transaction.id}`);
    let finalLockUntilBlock = await this.getCurrentBlockHeight();

    this.testing();

    console.info(`********** Starting balance: ${await this.getBalanceInSatoshis()}`);
    const unspentCoins = await this.getUnspentOutputs(this.privateKeyAddress);
    const currentHeight = await this.getCurrentBlockHeight();
    const lockUntilHeight = currentHeight + 3;
    const freezeAmountInSatoshis = 10000;

    const freezeTransaction = this.buildFreezeTransaction(unspentCoins, lockUntilHeight, freezeAmountInSatoshis);
    console.info('*************FREEZE Transaction');
    await this.decodeAndPrint(freezeTransaction.serialize());

    // await this.broadcastRpc(freezeTransaction.serialize());

    // while (lockUntilHeight > await this.getCurrentBlockHeight()) {
    //   await this.waitFor(60000);
    // }

    console.info(`********** Balance 2: ${await this.getBalanceInSatoshis()}`);
    finalLockUntilBlock = lockUntilHeight + 3;
    const spendToFreezeTransaction = this.buildSpendToFreezeTransaction(freezeTransaction, lockUntilHeight, finalLockUntilBlock);
    console.info('*************FREEZE 2 FREEZE Transaction');
    await this.decodeAndPrint((spendToFreezeTransaction.serialize as any)(true));

    // await this.broadcastRpc((spendToFreezeTransaction.serialize as any)(true));

    // while (finalLockUntilBlock > await this.getCurrentBlockHeight()) {
    //   await this.waitFor(60000);
    // }

    console.info(`********** Balance 3: ${await this.getBalanceInSatoshis()}`);
    const spendToWalletTransaction = this.buildSpendToWalletTransaction(spendToFreezeTransaction, finalLockUntilBlock);
    console.info('*************FREEZE 2 WALLET Transaction');
    await this.decodeAndPrint((spendToWalletTransaction.serialize as any)(true));

    // await this.broadcastRpc((spendToWalletTransaction.serialize as any)(true));
    // const [freezeTxn, spendTxn] = await this.buildFreezeAndSpendTransactions(unspentCoins, lockUntilHeight, 10000);

    const request = {
      method: 'sendrawtransaction',
      params: [
        rawTransaction
      ]
    };
    console.info(request);

    // return this.rpcCall(request, true);
    return transaction.hash;
  }

  private testing (): void {
    this.tryExecute(() => {
      const scriptAsHex = '03096319b17576a91489605b86b7ad185ebc10fe457b98776838972cf088ac';
      const script = new Script(Buffer.from(scriptAsHex, 'hex'));
      console.info(script.toASM());
    });

    const publicKeyAsHex = '02b40336640f23c0a8511a92bcde1b620f393cce722feaf6be16b009f447bbf0a2';

    this.tryExecute(() => {
      const publicKey = new PublicKey(publicKeyAsHex);
      const publicKeyAddress = (publicKey as any).toAddress('testnet');
      const publicKeyHashOut = Script.buildPublicKeyHashOut(publicKeyAddress);
      console.info(publicKeyHashOut);
    });

    this.tryExecute(() => {
      const publicKeyHd = new HDPrivateKey(Buffer.from(publicKeyAsHex, 'hex'));
      console.info(publicKeyHd.toString());
    });

    this.tryExecute(() => {
      const publicKeyHd2 = new HDPrivateKey(publicKeyAsHex);
      console.info(publicKeyHd2.toString());
    });
  }

  private tryExecute (expression: () => any): void {
    try {
      expression();
    } catch (e) {
      console.info(`***Exception during execution: ${JSON.stringify(e, Object.getOwnPropertyNames(e))}`);
    }
  }

  private buildFreezeTransaction (
    unspentCoins: Transaction.UnspentOutput[],
    freezeUntilBlock: number,
    freezeAmountInSatoshis: number): Transaction {

    console.info(`Lock until: ${freezeUntilBlock}`);

    const redeemScript = this.buildRedeemScript(freezeUntilBlock);
    const redeemScriptHash = Script.buildScriptHashOut(redeemScript);
    const payToScriptAddress = new Address(redeemScriptHash);

    // console.info(`########### PublicKeyHashOut: ${publicKeyHashOut}`);
    // console.info(`########### PayToScriptHash: ${payToScriptHash}`);

    const freezeTransaction = new Transaction()
                              .from(unspentCoins)
                              .to(payToScriptAddress, freezeAmountInSatoshis)
                              .fee(1000)
                              .change(this.privateKeyAddress)
                              .sign(this.privateKey);

    return freezeTransaction;
  }

  private buildSpendToFreezeTransaction (
    previousFreezeTransaction: Transaction,
    previousFreezeUntilBlock: number,
    lockUntilblock: number): Transaction {

    console.info(`Lock until: ${lockUntilblock}`);

    const redeemScript = this.buildRedeemScript(lockUntilblock);
    const redeemScriptHash = Script.buildScriptHashOut(redeemScript);
    const payToScriptAddress = new Address(redeemScriptHash);

    return this.buildSpendFromFrozenOutput(
      previousFreezeTransaction,
      previousFreezeUntilBlock,
      payToScriptAddress);

    //   // console.info(`########### PublicKeyHashOut: ${publicKeyHashOut}`);
    //   // console.info(`########### PayToScriptHash: ${payToScriptHash}`);
    // const previousFreezeRedeemScript = this.buildRedeemScript(previousFreezeUntilBlock);
    // const previousFreezeRedeemScriptHash = Script.buildScriptHashOut(previousFreezeRedeemScript);

    // const frozenOutputAsUnspentOutput = Transaction.UnspentOutput.fromObject({
    //   txid: previousFreezeTransaction.id,
    //   vout: 0,
    //   scriptPubKey: previousFreezeRedeemScriptHash,
    //   satoshis: previousFreezeTransaction.outputs[0].satoshis
    // });

    //   // unspentCoins = await this.getUnspentOutputs(this.privateKeyAddress);
    // // console.info(`********** New Balance: ${await this.getBalanceInSatoshis()}`);
    // const unfreezeFee = 1000;
    // const spendTransaction = new Transaction()
    //                            .from([frozenOutputAsUnspentOutput]) // .concat(unspentCoins))
    //                            .to(payToScriptAddress, freezeAmountInSatoshis - unfreezeFee)
    //                            .fee(unfreezeFee);
    //                            // .change(this.privateKeyAddress)
    //                            // .lockUntilBlockHeight(unlockBlock);

    // const signature = (Transaction as any).sighash.sign(spendTransaction, this.privateKey, 0x1, 0, redeemScript);

    // const inputScript = Script.empty()
    //                       .add(signature.toTxFormat())
    //                       .add(this.privateKey.toPublicKey().toBuffer())
    //                       .add(previousFreezeRedeemScript.toBuffer());

    // (spendTransaction.inputs[0] as any).setScript(inputScript);

    // return spendTransaction;
  }

  private buildSpendToWalletTransaction (
    previousFreezeTransaction: Transaction,
    previousFreezeUntilBlock: number): Transaction {

    return this.buildSpendFromFrozenOutput(
      previousFreezeTransaction,
      previousFreezeUntilBlock,
      this.privateKeyAddress);
  }

  private buildSpendFromFrozenOutput (
    previousFreezeTransaction: Transaction,
    previousFreezeUntilBlock: number,
    paytoAddress: Address): Transaction {

    const previousFreezeAmountInSatoshis = previousFreezeTransaction.outputs[0].satoshis;
    const previousFreezeRedeemScript = this.buildRedeemScript(previousFreezeUntilBlock);
    const previousFreezeRedeemScriptHash = Script.buildScriptHashOut(previousFreezeRedeemScript);

    const frozenOutputAsUnspentOutput = Transaction.UnspentOutput.fromObject({
      txid: previousFreezeTransaction.id,
      vout: 0,
      scriptPubKey: previousFreezeRedeemScriptHash,
      satoshis: previousFreezeAmountInSatoshis
    });

          // unspentCoins = await this.getUnspentOutputs(this.privateKeyAddress);
        // console.info(`********** New Balance: ${await this.getBalanceInSatoshis()}`);
    const unfreezeFee = 1000;
    const spendTransaction = new Transaction()
                                   .from([frozenOutputAsUnspentOutput]) // .concat(unspentCoins))
                                   .to(paytoAddress, previousFreezeAmountInSatoshis - unfreezeFee)
                                   .fee(unfreezeFee) // ;
                                   // .change(this.privateKeyAddress)
                                   .lockUntilBlockHeight(previousFreezeUntilBlock);

    const signature = (Transaction as any).sighash.sign(spendTransaction, this.privateKey, 0x1, 0, previousFreezeRedeemScript);

    const inputScript = Script.empty()
                              .add(signature.toTxFormat())
                              .add(this.privateKey.toPublicKey().toBuffer())
                              .add(previousFreezeRedeemScript.toBuffer());

    (spendTransaction.inputs[0] as any).setScript(inputScript);

    return spendTransaction;
  }

  private async decodeAndPrint (serializedTxn: string): Promise<void> {
    const request = {
      method: 'decoderawtransaction',
      params: [
        serializedTxn
      ]
    };

    const response = await this.rpcCall(request, true);
    console.debug(JSON.stringify(response));
  }

  // private async broadcastRpc (txnAsString: string): Promise<string> {
  //   const request = {
  //     method: 'sendrawtransaction',
  //     params: [
  //       txnAsString
  //     ]
  //   };

  //   const id = await this.rpcCall(request, true);
  //   console.info(`Broadcasted transaction: ${id}`);

  //   return id;

  //   // return Promise.resolve('123');
  // }

  private buildRedeemScript (lockUntilblock: number): Script {
    const lockBuffer = (crypto.BN as any).fromNumber(lockUntilblock).toScriptNumBuffer();
    const publicKeyHashOut = Script.buildPublicKeyHashOut(this.privateKeyAddress);

    const redeemScript = Script.empty()
                         .add(lockBuffer)
                         .add(177) // CLTV
                         .add(117) // DROP
                         .add(publicKeyHashOut);

    return redeemScript;
  }
  public async getBlock (hash: string): Promise<BitcoinBlockModel> {
    const request = {
      method: 'getblock',
      params: [
        hash,
        2 // verbosity value to get block + transactions' info
      ]
    };

    const block = await this.rpcCall(request, true);

    const transactionModels = block.tx.map((txn: any) => {
      const transactionBuffer = Buffer.from(txn.hex, 'hex');
      const bitcoreTransaction = BitcoinClient.createBitcoreTransactionFromBuffer(transactionBuffer);
      return BitcoinClient.createBitcoinTransactionModel(bitcoreTransaction);
    });

    return {
      hash: block.hash,
      height: block.height,
      previousHash: block.previousblockhash,
      transactions: transactionModels
    };
  }

  public async getBlockHash (height: number): Promise<string> {
    console.info(`Getting hash for block ${height}`);
    const hashRequest = {
      method: 'getblockhash',
      params: [
        height // height of the block
      ]
    };

    return this.rpcCall(hashRequest, true);
  }

  public async getBlockInfoFromHeight (height: number): Promise<IBlockInfo> {
    return this.getBlockInfo(await this.getBlockHash(height));
  }

  public async getBlockInfo (hash: string): Promise<IBlockInfo> {
    const request = {
      method: 'getblockheader',
      params: [
        hash,
        true // verbose
      ]
    };

    const response = await this.rpcCall(request, true);

    return {
      hash: hash,
      height: response.height,
      previousHash: response.previousblockhash
    };
  }

  public async getCurrentBlockHeight (): Promise<number> {
    console.info('Getting current block height...');
    const request = {
      method: 'getblockcount'
    };

    const response = await this.rpcCall(request, true);
    return response;
  }

  public async getBalanceInSatoshis (): Promise<number> {

    const unspentOutputs = await this.getUnspentOutputs(this.privateKeyAddress);

    const unspentSatoshis = unspentOutputs.reduce((total, unspentOutput) => {
      return total + unspentOutput.satoshis;
    }, 0);

    return unspentSatoshis;
  }

  public async getTransactionFeeInSatoshis (transactionId: string): Promise<number> {

    const transaction = await this.getRawTransaction(transactionId);

    let inputSatoshiSum = 0;
    for (let i = 0 ; i < transaction.inputs.length ; i++) {

      const currentInput = transaction.inputs[i];
      const transactionOutValue = await this.getTransactionOutValueInSatoshi(currentInput.previousTransactionId, currentInput.outputIndexInPreviousTransaction);

      inputSatoshiSum += transactionOutValue;
    }

    // transaction outputs in satoshis
    const transactionOutputs: number[] = transaction.outputs.map((output) => output.satoshis);

    const outputSatoshiSum = transactionOutputs.reduce((sum, value) => sum + value, 0);

    return (inputSatoshiSum - outputSatoshiSum);
  }

  private async addWatchOnlyAddressToWallet (publicKeyAsHex: string, rescan: boolean): Promise<void> {
    const request = {
      method: 'importpubkey',
      params: [
        publicKeyAsHex,
        'sidetree',
        rescan
      ]
    };

    await this.rpcCall(request, false);
  }

  private async isAddressAddedToWallet (address: string): Promise<boolean> {
    console.info(`Checking if bitcoin wallet for ${address} exists`);
    const request = {
      method: 'getaddressinfo',
      params: [
        address
      ]
    };

    const response = await this.rpcCall(request, true);
    return response.labels.length > 0 || response.iswatchonly;
  }

  /** Get the transaction out value in satoshi, for a specified output index */
  private async getTransactionOutValueInSatoshi (transactionId: string, outputIndex: number) {
    const transaction = await this.getRawTransaction(transactionId);

    // output with the desired index
    const vout = transaction.outputs[outputIndex];

    return vout.satoshis;
  }

  /**
   * Get the raw transaction data.
   * @param transactionId The target transaction id.
   */
  private async getRawTransaction (transactionId: string): Promise<BitcoinTransactionModel> {
    const request = {
      method: 'getrawtransaction',
      params: [
        transactionId,  // transaction id
        0   // get the raw hex-encoded string
      ]
    };

    const hexEncodedTransaction = await this.rpcCall(request, true);
    const transactionBuffer = Buffer.from(hexEncodedTransaction, 'hex');

    const bitcoreTransaction = BitcoinClient.createBitcoreTransactionFromBuffer(transactionBuffer);

    return BitcoinClient.createBitcoinTransactionModel(bitcoreTransaction);
  }

  // This function is specifically created to help with unit testing.
  private static createBitcoreTransactionFromBuffer (buffer: Buffer): Transaction {
    return new Transaction(buffer);
  }

  private async createBitcoreTransaction (transactionData: string, feeInSatoshis: number): Promise<Transaction> {
    const unspentOutputs = await this.getUnspentOutputs(this.privateKeyAddress);

    const transaction = new Transaction();
    transaction.from(unspentOutputs);
    transaction.addOutput(new Transaction.Output({
      script: Script.buildDataOut(transactionData),
      satoshis: 0
    }));
    transaction.change(this.privateKeyAddress);
    transaction.fee(feeInSatoshis);
    transaction.sign(this.privateKey);

    return transaction;
  }

  private static createBitcoinInputModel (bitcoreInput: Transaction.Input): BitcoinInputModel {
    return {
      previousTransactionId: bitcoreInput.prevTxId.toString('hex'),
      outputIndexInPreviousTransaction: bitcoreInput.outputIndex
    };
  }

  private static createBitcoinOutputModel (bitcoreOutput: Transaction.Output): BitcoinOutputModel {
    return {
      satoshis: bitcoreOutput.satoshis,
      scriptAsmAsString: bitcoreOutput.script.toASM()
    };
  }

  private static createBitcoinTransactionModel (bitcoreTransaction: Transaction): BitcoinTransactionModel {

    const bitcoinInputs = bitcoreTransaction.inputs.map((input) => { return BitcoinClient.createBitcoinInputModel(input); });
    const bitcoinOutputs = bitcoreTransaction.outputs.map((output) => { return BitcoinClient.createBitcoinOutputModel(output); });

    return {
      inputs: bitcoinInputs,
      outputs: bitcoinOutputs,
      id: bitcoreTransaction.id
    };
  }

  private async getUnspentOutputs (address: Address): Promise<Transaction.UnspentOutput[]> {

    // Retrieve all transactions by addressToSearch via BCoin Node API /tx/address/$address endpoint
    const addressToSearch = address.toString();
    console.info(`Getting unspent coins for ${addressToSearch}`);
    const request = {
      method: 'listunspent',
      params: [
        null,
        null,
        [addressToSearch]
      ]
    };
    const response: Array<any> = await this.rpcCall(request, true);

    const unspentTransactions = response.map((coin) => {
      return new Transaction.UnspentOutput(coin);
    });

    console.info(`Returning ${unspentTransactions.length} coins`);

    return unspentTransactions;
  }

  private async rpcCall (request: any, timeout: boolean): Promise<any> {
    // append some standard jrpc parameters
    request['jsonrpc'] = '1.0';
    request['id'] = Math.round(Math.random() * Number.MAX_SAFE_INTEGER).toString(32);

    const requestString = JSON.stringify(request);
    console.debug(`Sending jRPC request: id: ${request.id}, method: ${request['method']}`);

    const requestOptions: RequestInit = {
      body: requestString,
      method: 'post'
    };

    if (this.bitcoinAuthorization) {
      requestOptions.headers = {
        Authorization: `Basic ${this.bitcoinAuthorization}`
      };
    }

    const response = await this.fetchWithRetry(this.bitcoinPeerUri.toString(), requestOptions, timeout);

    const responseData = await ReadableStream.readAll(response.body);
    if (response.status !== httpStatus.OK) {
      const error = new Error(`Fetch failed [${response.status}]: ${responseData}`);
      console.error(error);
      throw error;
    }

    const responseJson = JSON.parse(responseData.toString());

    if ('error' in responseJson && responseJson.error !== null) {
      const error = new Error(`RPC failed: ${JSON.stringify(responseJson.error)}`);
      console.error(error);
      throw error;
    }

    return responseJson.result;
  }

  /**
   * Calls `nodeFetch` and retries with exponential back-off on `request-timeout` FetchError`.
   * @param uri URI to fetch
   * @param requestParameters Request parameters to use
   * @param setTimeout True to set a timeout on the request, and retry if times out, false to wait indefinitely.
   * @returns Response of the fetch
   */
  private async fetchWithRetry (uri: string, requestParameters?: RequestInit | undefined, setTimeout: boolean = true): Promise<Response> {
    let retryCount = 0;
    let timeout: number;
    do {
      timeout = this.requestTimeout * 2 ** retryCount;
      let params = Object.assign({}, requestParameters);
      if (setTimeout) {
        params = Object.assign(params, {
          timeout
        });
      }
      try {
        return await nodeFetch(uri, params);
      } catch (error) {
        if (error instanceof FetchError) {
          if (retryCount >= this.requestMaxRetries) {
            console.debug('Max retries reached. Request failed.');
            throw error;
          }
          switch (error.type) {
            case 'request-timeout':
              console.debug(`Request timeout (${retryCount})`);
              await this.waitFor(Math.round(timeout));
              console.debug(`Retrying request (${++retryCount})`);
              continue;
          }
        }
        console.error(error);
        throw error;
      }
    } while (true);
  }

  /**
   * Async timeout
   * @param milliseconds Timeout in milliseconds
   */
  private async waitFor (milliseconds: number) {
    return new Promise((resolve) => {
      setTimeout(resolve, milliseconds);
    });
  }
}
