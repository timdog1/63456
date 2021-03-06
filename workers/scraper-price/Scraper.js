
const EnumChainId = require("../../enum/chain.id");
const EnumContracts = require("../../enum/contracts");
const Bulk = require("./bulk/Bulk");
const Cache = require("./Cache");
const Token = require("./entity/Token");

const EnumAbi = require("../../enum/abi");
const EnumMainTokens = require("../../enum/mainTokens");
const EnumBulkTypes = require("../../enum/bulk.records.type");
const TokenHistory = require("./entity/TokenHistory");
const HistoryPirce = require("./entity/HistoryPirce");

const abiDecoder = require('abi-decoder');
const Router = require("./entity/Routers");
abiDecoder.addABI(EnumAbi[EnumChainId.BSC].TOKEN);
abiDecoder.addABI(EnumAbi[EnumChainId.BSC].ROUTERS.PANCAKE);

function relDiff( today, yesterday ) {
    return  100 * ( ( today - yesterday ) / ( (today+yesterday)/2 ) );
}
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

class Scraper {
    constructor ( web3 ) {
        this.web3 = web3;
        this.UPDATE_PRICE_INTERVAL = process.env.WRITE_TO_DB_SECONDS ; // create a new record for the prices every x seconds
        this.CHAIN_MAIN_TOKEN_PRICE = 0;
        
        this.cache = new Cache();
        this.bulk = new Bulk( this.cache );

        this.routers = new Router( this.cache, this.web3, this.bulk );
        this.tokens = new Token( this.cache, this.web3, this.bulk  );
        this.tokenHistories = new TokenHistory( this.cache );
        this.historyPrices = new HistoryPirce( this.cache );
        this.loopUpdateMainTokenPrice();
    }

    areEqualAdd( add1, add2 ){
        return add1.toLowerCase() == add2.toLowerCase();
    }
    isMainToken( contract ){
        return this.areEqualAdd(contract, EnumMainTokens[EnumChainId.BSC].MAIN);
    }
    

    async calculatePriceFromReserves( hash, routerAdd, sender, params, pair ) {

        let START = Date.now();

        // console.log(`[TIME] Retrive tx informations: ${(Date.now()-START)/1000}`);
        // START = Date.now();
        //let hash = txLogs.transactionHash;
        //let tx = await this.web3.eth.getTransaction(hash); // modificare
        //let sender = tx.from;
        //let reciver = tx.to;

        
        
        await this.updatePairPriceWithReserves(
            sender,
            routerAdd,
            hash,
            pair,
            //amountIn
        );

        console.log(`[TIME] Updated prices: ${(Date.now()-START)/1000}`);
    }

    // returns an array [ mainToken, dependantToken ];
    async tokenHierarchy( first_token, latest_token, history ){ 
        // to have consistency in data collection keep using the same mainToken and dependantToken if present in history
        if( history ){ 
            let mainTokenContract = history.mainToken;
            if( first_token.contract == mainTokenContract ) return [ first_token, latest_token ]
            else return [ latest_token, first_token ];
        }
       // compare wich of the tokens is used more frequently to create pairs. This means that the one with more pairs is the more common used

       let pairs_comparison; // true if first token is the main one, else false
        // cross chain
        if(
            this.areEqualAdd(EnumMainTokens[EnumChainId.BSC].MAIN, first_token.contract) &&
            EnumMainTokens[EnumChainId.BSC].STABLECOINS.includes(latest_token.contract)
        ) {
            pairs_comparison = false;
        } else if(
            this.areEqualAdd(EnumMainTokens[EnumChainId.BSC].MAIN, latest_token.contract) &&
            EnumMainTokens[EnumChainId.BSC].STABLECOINS.includes(first_token.contract)
        ){
            pairs_comparison = true;
        }
        else if( first_token.pairs_count == latest_token.pairs_count ){
            if( EnumMainTokens[EnumChainId.BSC].STABLECOINS.includes(first_token.contract) ) pairs_comparison = true;
            else if( EnumMainTokens[EnumChainId.BSC].STABLECOINS.includes(latest_token.contract) ) pairs_comparison = false;
            else if ( this.areEqualAdd(EnumMainTokens[EnumChainId.BSC].MAIN, first_token.contract) ) pairs_comparison = true;
            else if ( this.areEqualAdd(EnumMainTokens[EnumChainId.BSC].MAIN, latest_token.contract) ) pairs_comparison = false;
        } else {
            pairs_comparison = first_token.pairs_count > latest_token.pairs_count; // here pairs_count
        }
       
       let main_token = pairs_comparison ? first_token : latest_token;
       let dependant_token = pairs_comparison ? latest_token : first_token;
       return [ main_token, dependant_token ];
    }


    /**
     * @description Add the token price inside the Bulk history
     * @param {*} token0 address
     * @param {*} token1 address
     */
    async updatePairPriceWithReserves( 
        txSender, router, txHash, pairAddress,
        //amountIn
    ){

        let START = Date.now();

        let pair_contract = pairAddress;
        let pairWeb3Contract =  await new this.web3.eth.Contract( EnumAbi[EnumChainId.BSC].PAIR.PANCAKE, pair_contract );
        let first_reserves;

        let cachedPair = this.cache.getPair(pairAddress);
        let token0 = 0;
        let token1 = 0;
        try {
            first_reserves = await pairWeb3Contract.methods.getReserves().call();

            console.log(`[TIME] Retrive reserves: ${(Date.now()-START)/1000}`);
            START = Date.now();
            
            if( !cachedPair ){ 
                console.log('[PAIR] Not cached')
                token0 = await pairWeb3Contract.methods.token0().call();
                token1 = await pairWeb3Contract.methods.token1().call();
                // some lines below the pair is setted in the cache
            } else {
                token0 = cachedPair.tokens[0];
                token1 = cachedPair.tokens[1];
            }

        } catch (error) {
            return console.log( '[ERROR] CANNOT RETRIVE RESERVES', error );
        }

        console.log(`[TIME] Retrive pair info: ${(Date.now()-START)/1000}`);
        START = Date.now();

        console.log(`[TIME] Checking if router is valid: ${(Date.now()-START)/1000}`);
        START = Date.now();


        let tokenHistory = await this.tokenHistories.getTokenHistory( pair_contract );

        //console.log(`[TIME] Retrive history: ${(Date.now()-START)/1000}`);
        //START = Date.now();

        if(! this.bulk.bulk_normal.getHistory( pair_contract, EnumBulkTypes.TOKEN_HISTORY ) ) 
            this.bulk.bulk_normal.intializeBulkForContract( pair_contract, EnumBulkTypes.TOKEN_HISTORY );

        // console.log(`[TIME] Initialize history bulk: ${(Date.now()-START)/1000}`);
        // START = Date.now();
        
        let token0Infos = await this.tokens.getToken( token0 );
        let token1Infos = await this.tokens.getToken( token1 );

        this.cache.setPair( // create or update the pair inside the cache
            pairAddress, 
            { 
                tokens: [token0, token1],
                reserves: [ 
                    first_reserves[0]/(10**token0Infos.decimals),  
                    first_reserves[1]/(10**token1Infos.decimals)
                ] 
            }
        );
        
        
        // console.log(`[TIME] Retrive tokens: ${(Date.now()-START)/1000}`);
        // START = Date.now();

        if( !token0Infos || !token0Infos.contract || !token1Infos || !token1Infos.contract ) return;

        let [ mainToken, dependantToken ] = await this.tokenHierarchy(token0Infos, token1Infos, tokenHistory); // get who is the main token in the pair

        this.routers.getRouter( router, token0, token1, token0Infos.decimals );

        // console.log(`[TIME] Retrive token hierarchy: ${(Date.now()-START)/1000}`);
        // START = Date.now();
        
        // cross chain
        let mainTokenIsBNB = this.isMainToken( mainToken.contract );

        let dependantTokenPrice = null; // calculate the dependant token price
        if( mainToken.contract == token0 ) dependantTokenPrice = (first_reserves[0]/10**mainToken.decimals)/(first_reserves[1]/10**dependantToken.decimals); // here decimals
        else dependantTokenPrice = (first_reserves[1]/10**mainToken.decimals)/(first_reserves[0]/10**dependantToken.decimals); 

        if( mainTokenIsBNB ){ // if the main token was BNB then multiply for get the token usd value
            if(this.CHAIN_MAIN_TOKEN_PRICE){
                dependantTokenPrice = dependantTokenPrice * this.CHAIN_MAIN_TOKEN_PRICE;
            }
        } 

        
    
        if( !tokenHistory ){
            tokenHistory = {
                records_transactions: 0,
                records_price: 0,
                chain: EnumChainId.BSC, // cross chain
                token0: {
                    contract: token0Infos.contract,
                    name: token0Infos.name,
                    symbol: token0Infos.symbol
                },
                token1: {
                    contract: token1Infos.contract,
                    name: token1Infos.name,
                    symbol: token1Infos.symbol
                },
                router: router,
                pair: pair_contract,
                mainToken: mainToken.contract,
                dependantToken: dependantToken.contract
            };
            
            console.log(`[BULK ADD CREATE] ${Object.keys(this.bulk.bulk_normal.getHistories(EnumBulkTypes.TOKEN_HISTORY)).length} ${dependantToken.contract}`);
            this.bulk.bulk_normal.setNewDocument( pair_contract, EnumBulkTypes.TOKEN_HISTORY, tokenHistory );
            this.cache.setHistory(pair_contract, tokenHistory);
        }

        // console.log(`[TIME] Minor calculations: ${(Date.now()-START)/1000}`);
        // START = Date.now();
        
        
        console.log(`[INFO] MAIN: ${mainToken.contract} | DEPENDANT: ${dependantToken.contract} | ${pairAddress}`); 
        console.log(`[INFO] DEPENDANT PRICE: ${dependantTokenPrice}$ | ${pairAddress} `);
        
        let reserve0 = first_reserves[0]/10**token0Infos.decimals;
        let reserve1 = first_reserves[1]/10**token1Infos.decimals;

        let pairHistory = await this.historyPrices.getHistory(pair_contract);

        // console.log(`[TIME] Getting history: ${(Date.now()-START)/1000}`);
        // START = Date.now();

        await this.updatePrice( 
            router, pair_contract, dependantToken.contract, mainToken.contract,
            pairHistory.latest, dependantTokenPrice, 
            reserve0, reserve1 
        );

        // console.log(`[TIME] Updating price: ${(Date.now()-START)/1000}`);
        // START = Date.now();

        // update the pair records
        this.bulk.bulk_normal.setTokenBulkInc( pair_contract, EnumBulkTypes.TOKEN_HISTORY ,`records_transactions`, 1 );
        this.bulk.bulk_normal.setTokenBulkSet( pair_contract, EnumBulkTypes.TOKEN_HISTORY ,'reserve0', reserve0);
        this.bulk.bulk_normal.setTokenBulkSet( pair_contract, EnumBulkTypes.TOKEN_HISTORY ,'reserve1', reserve1);
        this.bulk.bulk_normal.setTokenBulkSet( pair_contract, EnumBulkTypes.TOKEN_HISTORY ,'price', dependantTokenPrice);

        // detect the main reseve and the dependant token reserve in the pair
        let mainReserve;
        let dependantReserve;
        if( mainToken.contract == token0 ) {
            mainReserve = reserve0;
            dependantReserve = reserve1;
        } else {
            mainReserve = reserve1;
            dependantReserve = reserve0;
        }

        let mainReserveValue = mainReserve; 
        if( mainTokenIsBNB ) mainReserveValue = mainReserve * this.CHAIN_MAIN_TOKEN_PRICE; // if the main token of the pair is BNB then multiply the tokens in the pair reserver * bnb price
        this.bulk.bulk_normal.setTokenBulkSet( pair_contract, EnumBulkTypes.TOKEN_HISTORY, 'mainReserveValue', mainReserveValue);

        // update daily variation percentage
        let dayAgoHistoryPrice = pairHistory.day;
        if( dayAgoHistoryPrice ){ 
            let dailyVariation = relDiff(dependantTokenPrice, dayAgoHistoryPrice.value).toFixed(2);
            this.bulk.bulk_normal.setTokenBulkSet( pair_contract, EnumBulkTypes.TOKEN_HISTORY, 'variation.day', dailyVariation );
            console.log(`[UPDATING PERCENTAGE DAILY] ${pair_contract} ${dailyVariation}`)
        }

        // console.log(`[TIME] Update other minor infos: ${(Date.now()-START)/1000}`);
        // START = Date.now();

        /**
         * - TODO
         * Currently the price in usd relative to the amount of mainTokens transferred during the swap is not directly calculated
         * except if the main token is BNB.
         * 
         * Assuming that most of the swap are made through bnb or stable coins
         * then the script calculates for the following swap transactions this usd volumes
         * 
         * - 2BNB -> 100TOKEN : usd value of 2 * BNB_PRICE_IN_USD [ correct approach ]
         * 
         * - 10USDT -> 100TOKEN : usd value of 10 * 1. [ mostly correct approach ]
         * - it do not really uses the USDT value to calculate the volumne, but just use the amount of USDT transferred 
         * - to infer the value since USDT is pegged to USD. 
         * 
         * this approach can me mostly correct with BNB and stable coins with high market cap
         * but if we have as mainToken some other random tokens we will have the following behaviour
         * 
         * 100 DOGE -> 100 TOKEN: value of 100 * 1 [ wrong approach ]
         * so the transaction usd volume will result as 100 usd, instead it should be 100 * DOGE_PRICE_IN_USD
         * 
         * The main problem is that retriveing the price of each mainToken that is not bnb or a stable coin is highly expensive becouse
         * we have to make many read operations to the database, and if we manage 500-1500 transaction per seconds or more it will result in
         * a big LAG of all the apllications running on our system.
         * 
         * Something like the currently used cache system should be implemented, but the price of this tokens can vary from moment to moment,
         * so each time that the price of this tokens changes we should update the cache as well.
         * 
        */

        /*****
        // update transactions object
        let type; // track if transaction is buy or sell
        let transferredTokensValue; // track the amount of mainToken used in ths transactions
        let transferredTokensAmount;
        let mainTokenPrice = 1; // if set to 1 it will have no impact on the multiplications below, it will be always be 1 except when the main token is BNB
        if( mainTokenIsBNB ) mainTokenPrice = this.CHAIN_MAIN_TOKEN_PRICE[0];

        let amountOut; 
        let amountOutWithDecimals;
        if( mainToken.contract == tokenOriginalOrder[0] ){
            amountOut = ( dependantReserve/mainReserve ) * (amountIn/10**mainToken.decimals) ;
            amountOutWithDecimals = amountOut * ( 10 ** dependantToken.decimals );
            transferredTokensValue = (amountIn/10**mainToken.decimals) * mainTokenPrice;
            transferredTokensAmount = amountOut;
            type = 0;
        } else {
            amountOut = ( mainReserve/dependantReserve ) * (amountIn/10**dependantToken.decimals);
            amountOutWithDecimals = amountOut * ( 10 ** mainToken.decimals );
            transferredTokensValue = amountOut * mainTokenPrice;
            transferredTokensAmount = (amountIn/10**dependantToken.decimals);
            type = 1;
        }

        let time = Date.now()/1000;
        console.log('[SETTING TRANSACTION] ', pair_contract, time)
        this.bulk.bulk_time.setNewDocument( pair_contract, EnumBulkTypes.HISOTRY_TRANSACTION, time, {
            time: time, // unix timestamp
            type: type, // [ buy -> type = 1 ]. [ sell -> type = 0 ]
            hash: txHash,
            from: txSender,
            value: transferredTokensValue,
            amount: transferredTokensAmount,
            pair: pair_contract,
            router: router,
            dependantToken: dependantToken.contract,
            mainToken: mainToken.contract
        }, false, 0.0001, true);

        return amountOutWithDecimals;
        *******/
    }

    getTime() { return Math.floor((Date.now()/1000)/this.UPDATE_PRICE_INTERVAL) * this.UPDATE_PRICE_INTERVAL }
    async updatePrice( router, pair, tokenAddress, mainTokenAddress, latestHistoryPirce, newPrice, reserve0, reserve1 ) {
    
        let time = this.getTime();
        let tokenInfo = this.cache.getToken(tokenAddress);
        if( !newPrice ) return;
        

        let latestHistory = latestHistoryPirce;
        let latestHistoryTime = latestHistory ? latestHistory.time: 0;

        let latestHigh = latestHistory ? latestHistory.high : 0;
        let latestLow = latestHistory ? latestHistory.low : 0 ;

        console.log(`[UPDATING PRICE]`, pair)

        if( ( time - latestHistoryTime ) < this.UPDATE_PRICE_INTERVAL ){ // update latest record
            
            if( newPrice > latestHigh ){
                this.bulk.bulk_time.setTokenBulkSet( pair, EnumBulkTypes.HISTORY_PRICE, time, 'high', newPrice );
            }
            if( newPrice < latestLow ){
                this.bulk.bulk_time.setTokenBulkSet( pair, EnumBulkTypes.HISTORY_PRICE, time, 'low', newPrice );
            }
            // update the value anyway also if it is not higher that the high or lower than the low 
            this.bulk.bulk_time.setTokenBulkSet( pair, EnumBulkTypes.HISTORY_PRICE, time, 'value', newPrice );
            this.bulk.bulk_time.setTokenBulkSet( pair, EnumBulkTypes.HISTORY_PRICE, time, 'reserve0', reserve0 );
            this.bulk.bulk_time.setTokenBulkSet( pair, EnumBulkTypes.HISTORY_PRICE, time, 'reserve1', reserve1 );
            
            
        } else { // create new record  

            
            if( !latestHistoryTime || typeof latestHistoryTime != 'number' ){  // load the time of the last time that this price was updated so that we can change the 'close' parameter
                console.log(`[CLOSE RETRIVE] RETRIVING LAST HISTORY ${pair}. ${latestHistoryTime}`);
                latestHistoryTime = await this.historyPrices.getLastHistoryTime(pair, time);
                console.log(`[CLOSE RETRIVE] RETRIVED ${latestHistoryTime} ${pair}`)
            }
            if( latestHistoryTime ){ // update the close parameter
                console.log(`[CLOSE] UPDATING ${latestHistoryTime} WITH ${newPrice}. ${pair}`)
                this.bulk.bulk_time.setTokenBulkSet( pair, EnumBulkTypes.HISTORY_PRICE, latestHistoryTime, 'close', newPrice );
            } else {
                console.log(`[CLOSE FAIL] CANNOT UPDATE ${latestHistoryTime} WITH ${newPrice}. ${pair}`)
            }
            
            console.log(`[CREATING RECORD] ${pair}. LAST RECORD: ${latestHistoryTime}`);
            this.bulk.bulk_time.setNewDocument( pair, EnumBulkTypes.HISTORY_PRICE, time, {
                time: time, // to have standard intervals, for example the exact minutes on the time. 9:01, 9:02, 9:03
                open: newPrice,
                close: newPrice,
                high: newPrice,
                low: newPrice,
                value: newPrice,
                burned: tokenInfo ? tokenInfo.burned : null,
                mcap: tokenInfo ? (tokenInfo.total_supply - tokenInfo.burned) * newPrice : 0,
      
                pair: pair,
                router: router,
                mainToken: mainTokenAddress,
                dependantToken: tokenAddress
            } );

            if( tokenInfo ) {
                this.bulk.bulk_normal.setTokenBulkSet(pair, EnumBulkTypes.TOKEN_HISTORY, 'burned', tokenInfo.burned )
                this.bulk.bulk_normal.setTokenBulkSet(pair, EnumBulkTypes.TOKEN_HISTORY, 'mcap', (tokenInfo.total_supply - tokenInfo.burned) * newPrice )
            }
                
            this.bulk.bulk_normal.setTokenBulkSet(pair, EnumBulkTypes.TOKEN_HISTORY, 'value', newPrice );
            this.bulk.bulk_normal.setTokenBulkInc(pair, EnumBulkTypes.TOKEN_HISTORY, 'records_price', 1);
        }
    }

    async loopUpdateMainTokenPrice(){
        // cross chain
        let FACTORY = await new this.web3.eth.Contract( EnumAbi[EnumChainId.BSC].FACTORIES.PANCAKE, EnumContracts[EnumChainId.BSC].FACTORIES.PANCAKE );
        while( true ){
            try {
                let mainTokenPairAddress = await FACTORY.methods.getPair( EnumMainTokens[EnumChainId.BSC].WBNB.address, EnumMainTokens[EnumChainId.BSC].USDT.address ).call();
                let mainTokenPair = await new this.web3.eth.Contract( EnumAbi[EnumChainId.BSC].PAIR.PANCAKE, mainTokenPairAddress );
                let reserves = await mainTokenPair.methods.getReserves().call();
                let WBNB_RESERVE = reserves[1]/10**EnumMainTokens[EnumChainId.BSC].WBNB.decimals;
                let USDT_RESERVE = reserves[0]/10**EnumMainTokens[EnumChainId.BSC].USDT.decimals;
                let WBNB_PRICE = USDT_RESERVE/WBNB_RESERVE;
                this.CHAIN_MAIN_TOKEN_PRICE = WBNB_PRICE;
            } catch (error) {
                console.log(`[ERR UPDATING MAIN PRICE] ${error}`);
            }
            await sleep(5000);
        }
    }
    
}

module.exports = Scraper;