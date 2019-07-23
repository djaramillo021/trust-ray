import * as winston from "winston";
import { TransactionParser } from "./TransactionParser";
import { BlockchainState } from "./BlockchainState";
import { TokenParser } from "./TokenParser";
import { Config } from "./Config";
import { LastParsedBlock } from "../models/LastParsedBlockModel";
import { setDelay } from "./Utils";
import TeamMessage from "../slack/Team";
const config = require("config");




/**
 * Parses the blockchain for transactions and tokens.
 * Delegates most of the work to the TransactionParser
 * and TokenParser classes. Mainly responsible for
 * coordinating the flow.
 */
export class BlockchainParser {
    private _simulateProblem: boolean = (process.env.SIMULATE_PROBLEM == 'true');
    private transactionParser: TransactionParser;
    private tokenParser: TokenParser;
    private teamMessage: TeamMessage;
    private maxConcurrentBlocks: number = parseInt(config.get("PARSER.MAX_CONCURRENT_BLOCKS")) || 2;
    private rebalanceOffsets: number[] = [15];
    private forwardParsedDelay: number = parseInt(config.get("PARSER.DELAYS.FORWARD")) || 100;
    private backwardParsedDelay: number = parseInt(config.get("PARSER.DELAYS.BACKWARD")) || 300;

    private limitToReset: number = parseInt(process.env.LIMIT_RESET) || 10*60000;
    private counToReset:number=0;
    private latestBlkNumberInDB:number=null;
    private idNode: string = process.env.ID_NODE;

    constructor() {
        this.transactionParser = new TransactionParser();
        this.tokenParser = new TokenParser();
        this.teamMessage= new TeamMessage();
    }

    public start() {
        this.startForwardParsing();
        this.scheduleBackwardParsing();

        
    }

    public startForwardParsing() {
        return BlockchainState.getBlockState().then(async ([blockInChain, blockInDb]) => {
            const startBlock = blockInDb ? blockInDb.lastBlock : blockInChain - 1;
            const nextBlock: number = startBlock + 1;

            //autostop
            const latestBlockNumberInDB = blockInDb.lastBlock;
            if(this.latestBlkNumberInDB==null){
                this.latestBlkNumberInDB=latestBlockNumberInDB;
            } else{
                if(this.latestBlkNumberInDB==latestBlockNumberInDB)
                {
                    this.counToReset=this.counToReset+1;
                } else {
                    this.counToReset=0;
                }
                this.latestBlkNumberInDB=latestBlockNumberInDB;
            }


            if(this.counToReset>this.limitToReset){
                winston.error(`ForceReset blocksToSync: ${this.latestBlkNumberInDB}`);
                await this.teamMessage.sendMessage(`The nodo[${this.idNode}] trust-ray resets ,  blocksToSync: ${this.latestBlkNumberInDB} `);
                return process.exit(22);
            }
            

            if (nextBlock <= blockInChain) {
                winston.info(`Forward ==> parsing blocks range ${nextBlock} - ${blockInChain}. Difference ${blockInChain - startBlock}`);

                const lastBlock = blockInChain
                this.parse(nextBlock, blockInChain, true).then((endBlock: number) => {
                    return this.saveLastParsedBlock(endBlock);
                }).then((saved: {lastBlock: number}) => {
                    this.scheduleForwardParsing(this.forwardParsedDelay);
                }).catch((err: Error) => {
                    winston.error(`Forward parsing failed for blocks ${nextBlock} to ${lastBlock} with error: ${err}. \nRestarting parsing for those blocks...`);
                    this.scheduleForwardParsing();
                });
            } else {
                winston.info("Last block is parsed on the blockchain, waiting for new blocks");
                this.scheduleForwardParsing();
            }






        }).catch((err: Error) => {
            winston.error("Failed to load initial block state in startForwardParsing: " + err);
            this.scheduleForwardParsing();
        });
    }

    public startBackwardParsing() {
        return this.getBlockState().then(([blockInChain, blockInDb]) => {
            const startBlock = !blockInDb ? blockInChain : (((blockInDb.lastBackwardBlock == undefined) ? blockInChain : blockInDb.lastBackwardBlock));

            const nextBlock: number = startBlock - 1;
            if (nextBlock < 1) {
                winston.info(`Backward already finished`);
                return;
            }

            if (nextBlock >= blockInChain) {
                return this.scheduleBackwardParsing();
            }
            winston.info(`<== Backward parsing blocks range ${nextBlock} - ${blockInChain}. Difference ${blockInChain - startBlock}`);

            this.parse(nextBlock, blockInChain, false).then((endBlock: number) => {
                return this.saveLastBackwardBlock(endBlock);
            }).then((block) => {
                return setDelay(this.backwardParsedDelay).then(() => {
                    if (block.lastBackwardBlock > 1) {
                        return this.startBackwardParsing();
                    } else {
                        winston.info(`Finished parsing backward`);
                    }
                })
            }).catch((err: Error) => {
                winston.error(`Backword parsing failed for blocks ${nextBlock} with error: ${err}. \nRestarting parsing for those blocks...`);
                this.scheduleBackwardParsing();
            });
        }).catch((err: Error) => {
            winston.error("Failed to load initial block state in startBackwardParsing: " + err);
            this.scheduleBackwardParsing();
        });
    }

    private scheduleForwardParsing(delay: number = 3000) {
        setDelay(delay).then(() => {
            this.startForwardParsing();
        });
    }

    private scheduleBackwardParsing() {
        setDelay(2000).then(() => {
            this.startBackwardParsing();
        });
    }

    private getBlockState(): Promise<any[]> {
        const latestBlockOnChain = Config.web3.eth.getBlockNumber();
        const latestBlockInDB = LastParsedBlock.findOne();
        return Promise.all([latestBlockOnChain, latestBlockInDB]);
    }

    getBlocksRange(start: number, end: number): number[] {
        return Array.from(Array(end - start + 1).keys()).map((i: number) => i + start);
    }

    getBlocksToParse(startBlock: number, endBlock: number, concurrentBlocks: number): number {
        const blocksDiff: number = 1 + endBlock - startBlock;
        return endBlock - startBlock <= 0 ? 1 : blocksDiff > concurrentBlocks ? concurrentBlocks : blocksDiff;
    }

    getNumberBlocks(startBlock: number, lastBlock: number, ascending: boolean, rebalanceOffsets: number[]): number[] {
        const blocksToProcess = this.getBlocksToParse(startBlock, lastBlock, this.maxConcurrentBlocks);
        const startBlockRange: number = ascending ? startBlock : Math.max(startBlock - blocksToProcess + 1, 0);
        const endBlockRange: number = startBlockRange + blocksToProcess - 1;
        const numberBlocks: number[] = this.getBlocksRange(startBlockRange, endBlockRange);

        if (lastBlock - startBlock < Math.min(...this.rebalanceOffsets) && ascending) {
            rebalanceOffsets.forEach((rebalanceOffset: number) => {
                const rebalanceBlock: number = startBlock - rebalanceOffset;
                if (rebalanceBlock > 0) {
                    numberBlocks.unshift(rebalanceBlock);
                }
            });
        }

        return numberBlocks;
    }
    private parse(startBlock: number, lastBlock: number, ascending: boolean = true): Promise<number> {
        if (startBlock % 20 === 0) {
            winston.info(`Currently processing blocks range ${startBlock} - ${lastBlock} in ascending ${ascending} mode`);
        }
        const numberBlocks = this.getNumberBlocks(startBlock, lastBlock, ascending, this.rebalanceOffsets);
        const promises = numberBlocks.map((number, i) => {
            winston.info(`${ascending ? `Forward` : `Backward`} processing block ${ascending ? number : numberBlocks[i]}`);
            return Config.web3.eth.getBlock(number, true);
        });
        return Promise.all(promises).then((blocks: any) => {
            const hasNullBlocks = blocks.filter((block: any) => block === null);
            if (hasNullBlocks.length > 0) {
                return Promise.reject("Has null blocks. Wait for RPC to build a block");
            }
            return this.transactionParser.parseTransactions(this.flatBlocksWithMissingTransactions(blocks));
        }).then((transactions: any) => {
            return this.tokenParser.parseERC20Contracts(transactions);
        }).then(([transactions, contracts]: any) => {
            return this.transactionParser.parseTransactionOperations(transactions, contracts);
        }).then(() => {
            const endBlock = ascending ? numberBlocks[numberBlocks.length - 1] : numberBlocks[0];
            return endBlock ? Promise.resolve(endBlock) : Promise.reject(endBlock);
        });
    }

    private saveLastParsedBlock(block: number) {

        if(this._simulateProblem===true){
            winston.error(`Force Simulate: ${this._simulateProblem}`);
            return LastParsedBlock.findOneAndUpdate({}, {}, {upsert: true, new: true}).catch((err: Error) => {
                winston.error(`Could not save last parsed block to DB with error: ${err}`);
            });
        }

        return LastParsedBlock.findOneAndUpdate({}, {lastBlock: block}, {upsert: true, new: true}).catch((err: Error) => {
            winston.error(`Could not save last parsed block to DB with error: ${err}`);
        });
    }

    private saveLastBackwardBlock(block: number) {
        if(this._simulateProblem===true){
            winston.error(`Force Simulate: ${this._simulateProblem}`);
            return LastParsedBlock.findOneAndUpdate({}, {}, {upsert: true, new: true}).catch((err: Error) => {
                winston.error(`Could not save last parsed block to DB with error: ${err}`);
            });
        }
        
        return LastParsedBlock.findOneAndUpdate({}, {lastBackwardBlock: block}, {upsert: true}).catch((err: Error) => {
            winston.error(`Could not save lastest backward block to DB with error: ${err}`);
        });
    }

    private flatBlocksWithMissingTransactions(blocks: any) {
        return blocks
            .map((block: any) => (block !== null && block.transactions !== null && block.transactions.length > 0)
                ? [block]
                : [])
            .reduce( (a: any, b: any) => a.concat(b), [] );
    }

}
