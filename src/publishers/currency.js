'use strict'

const lib = require('xrpl-accountlib')
const dotenv = require('dotenv')
const logger = require('../logger.js');

dotenv.config()
const MAX_SUBMIT_RETRIES = process.env.MAX_SUBMIT_RETRIES == null ? 1 : parseInt(process.env.MAX_SUBMIT_RETRIES);

module.exports = class CurrencyPublisher {
  constructor() {
    Object.assign(this, {
      async publish(Connection, data, sequence, fee, count, stats, oracle) {
        let retry = null

        if (!('rawResultsNamed' in data)) { return }

        logger.debug('GOT DATA')
        logger.debug({data})

        const Memos = Object.keys(data.rawResultsNamed).map(k => {
          return {
            Memo: {
              MemoData: Buffer.from(data.rawResultsNamed[k].map(_v => String(_v)).join(';'), 'utf-8').toString('hex').toUpperCase(),
              MemoFormat: Buffer.from('text/csv', 'utf-8').toString('hex').toUpperCase(),
              MemoType: Buffer.from('rates:' + k, 'utf-8').toString('hex').toUpperCase()
            }
          }
        })

        let filteredMedian = String(data.filteredMedian)
        const exp = filteredMedian.split('.')
        if (exp.length == 2) {
          filteredMedian = exp[0] + '.' + exp[1].substring(0, 10)
        }
        
        let code = data.symbol.substring('XRP/'.length)
        if (code.length > 3) {
          code = this.currencyUTF8ToHex(code)
        }
        const trxFee = fee + count
        const Tx = {
          TransactionType: 'TrustSet',
          Account: process.env.XRPL_SOURCE_ACCOUNT,
          Fee: trxFee.toString(),
          Flags: 131072,
          Sequence: sequence,
          LimitAmount: {
            currency: code,
            issuer: process.env.XRPL_DESTINATION_ACCOUNT,
            value: filteredMedian
          },
          Memos
        }
        // logger.debug(Tx)

        logger.debug('SIGN & SUBMIT')
        try {
          const keypair = lib.derive.familySeed(process.env.XRPL_SOURCE_ACCOUNT_SECRET)
          const {signedTransaction} = lib.sign(Tx, keypair)
          const Signed = await Connection.send({ command: 'submit', 'tx_blob': signedTransaction })

          // log({Signed})
          // terQUEUED: "... did not meet the open ledger requirement, so the transaction has been queued for a future ledger."
          var successResult = [ 'tesSUCCESS', 'terQUEUED'] 
          if (!successResult.includes(Signed.engine_result)) {
            data.last_error = Signed.engine_result
            // Consider retry as error after reaching max submit retries
            var retryResult = [ 'terPRE_SEQ', 'tefPAST_SEQ', 'telCAN_NOT_QUEUE_FEE', 'telCAN_NOT_QUEUE_FULL']
            if (!retryResult.includes(Signed.engine_result) || data.maxRetry == MAX_SUBMIT_RETRIES) {
              stats.last_error = Signed.engine_result
              stats.last_error_occured = new Date()
            }
            retry = this.resubmitTx(data, oracle)
          }
          else {
            logger.debug('Signed ' + data.symbol)
            stats.last_published = new Date()
            stats.last_fee = trxFee
            stats.submissions_since_start ++
          }
        } catch (e) {
          var usedParams = `sequence: ${sequence}, trxFee: ${trxFee}, code: ${code}, filteredMedian: ${filteredMedian}`
          logger.error(`Error signing / submitting: ${e.message}, usedParams: ${usedParams}`, e);
          retry = this.resubmitTx(data, oracle)
        }
        logger.debug('WRAP UP')
      },
      resubmitTx(data, oracle) {
        // make sure a stuck transaction at somepoint falls off our queue
        if (!('maxRetry' in data)) {
          data.maxRetry = 0
        }
        data.maxRetry++
        if (data.maxRetry <= MAX_SUBMIT_RETRIES) {
          oracle.retryPublish(data)
          logger.info('RESUBMIT: ' + data.symbol)
        }
      },
      currencyUTF8ToHex(code){
        if(/^[a-zA-Z0-9\?\!\@\#\$\%\^\&\*\<\>\(\)\{\}\[\]\|\]\{\}]{3}$/.test(code))
          return code
    
        if(/^[A-Z0-9]{40}$/.test(code))
          return code
    
        let hex = ''
    
        for(let i=0; i<code.length; i++){
          hex += code.charCodeAt(i).toString(16)
        }
    
        return hex.toUpperCase().padEnd(40, '0')
      }
    })
  }
}