import {
    TrustScoreDatabase,
    TokenPerformance,
    TradePerformance,
    TokenRecommendation,
    ProcessedTokenData,
} from "@ai16z/plugin-trustdb";
import { Connection, PublicKey } from "@solana/web3.js";
// Assuming TokenProvider and IAgentRuntime are available
import { TokenProvider } from "./token.ts";
import { settings } from "@ai16z/eliza";
import { IAgentRuntime, Memory, Provider, State } from "@ai16z/eliza";
import { WalletProvider } from "./wallet.ts";
import * as amqp from "amqplib";

interface SellDetails {
    sell_amount: number;
    sell_recommender_id: string | null;
}

export class simulationSellingService {
    private trustScoreDb: TrustScoreDatabase;
    private walletProvider: WalletProvider;
    private connection: Connection;
    private baseMint: PublicKey;
    private DECAY_RATE = 0.95;
    private MAX_DECAY_DAYS = 30;
    private backend: string;
    private backendToken: string;
    private amqpConnection: amqp.Connection;
    private amqpChannel: amqp.Channel;
    private sonarBe: string;
    private sonarBeToken: string;

    private runningProcesses: Set<string> = new Set();

    constructor(
        runtime: IAgentRuntime,
        trustScoreDb: TrustScoreDatabase,
        walletProvider: WalletProvider
    ) {
        this.trustScoreDb = trustScoreDb;

        this.connection = new Connection(runtime.getSetting("RPC_URL"));
        this.walletProvider = new WalletProvider(
            this.connection,
            new PublicKey(runtime.getSetting("WALLET_PUBLIC_KEY"))
        );
        this.baseMint = new PublicKey(
            runtime.getSetting("BASE_MINT") ||
                "So11111111111111111111111111111111111111112"
        );
        this.backend = runtime.getSetting("BACKEND_URL");
        this.backendToken = runtime.getSetting("BACKEND_TOKEN");
        this.initializeRabbitMQ(runtime.getSetting("AMQP_URL"));
        this.sonarBe = runtime.getSetting("SONAR_BE");
        this.sonarBeToken = runtime.getSetting("SONAR_BE_TOKEN");
    }
    /**
     * Initializes the RabbitMQ connection and starts consuming messages.
     * @param amqpUrl The RabbitMQ server URL.
     */
    private async initializeRabbitMQ(amqpUrl: string) {
        try {
            this.amqpConnection = await amqp.connect(amqpUrl);
            this.amqpChannel = await this.amqpConnection.createChannel();
            console.log("Connected to RabbitMQ");
            // Start consuming messages
            this.consumeMessages();
        } catch (error) {
            console.error("Failed to connect to RabbitMQ:", error);
        }
    }

    /**
     * Sets up the consumer for the specified RabbitMQ queue.
     */
    private async consumeMessages() {
        const queue = "process_eliza_simulation";
        await this.amqpChannel.assertQueue(queue, { durable: true });
        this.amqpChannel.consume(
            queue,
            (msg) => {
                if (msg !== null) {
                    const content = msg.content.toString();
                    this.processMessage(content);
                    this.amqpChannel.ack(msg);
                }
            },
            { noAck: false }
        );
        console.log(`Listening for messages on queue: ${queue}`);
    }

    /**
     * Processes incoming messages from RabbitMQ.
     * @param message The message content as a string.
     */
    private async processMessage(message: string) {
        try {
            const { tokenAddress, amount, sell_recommender_id } =
                JSON.parse(message);
            console.log(
                `Received message for token ${tokenAddress} to sell ${amount}`
            );

            const decision: SellDecision = {
                tokenPerformance:
                    await this.trustScoreDb.getTokenPerformance(tokenAddress),
                amountToSell: amount,
                sell_recommender_id: sell_recommender_id,
            };

            // Execute the sell
            await this.executeSellDecision(decision);

            // Remove from running processes after completion
            this.runningProcesses.delete(tokenAddress);
        } catch (error) {
            console.error("Error processing message:", error);
        }
    }

    /**
     * Executes a single sell decision.
     * @param decision The sell decision containing token performance and amount to sell.
     */
    private async executeSellDecision(decision: SellDecision) {
        const { tokenPerformance, amountToSell, sell_recommender_id } =
            decision;
        const tokenAddress = tokenPerformance.tokenAddress;

        try {
            console.log(
                `Executing sell for token ${tokenPerformance.tokenSymbol}: ${amountToSell}`
            );

            // Update the sell details
            const sellDetails: SellDetails = {
                sell_amount: amountToSell,
                sell_recommender_id: sell_recommender_id, // Adjust if necessary
            };
            const sellTimeStamp = new Date().toISOString();
            const tokenProvider = new TokenProvider(
                tokenAddress,
                this.walletProvider
            );

            // Update sell details in the database
            const sellDetailsData = await this.updateSellDetails(
                tokenAddress,
                tokenPerformance.recommenderId,
                sellTimeStamp,
                sellDetails,
                true, // isSimulation
                tokenProvider
            );

            console.log("Sell order executed successfully", sellDetailsData);

            // check if balance is zero and remove token from running processes
            const balance = this.trustScoreDb.getTokenBalance(tokenAddress);
            if (balance === 0) {
                this.runningProcesses.delete(tokenAddress);
            }
            // stop the process in the sonar backend
            await this.stopProcessInTheSonarBackend(tokenAddress);
        } catch (error) {
            console.error(
                `Error executing sell for token ${tokenAddress}:`,
                error
            );
        }
    }

    public async startService() {
        // starting the service
        console.log("Starting SellingService...");
        await this.startListeners();
    }

    private async startListeners() {
        // scanning recommendations and selling
        console.log("Scanning for token performances...");
        const tokenPerformances =
            await this.trustScoreDb.getAllTokenPerformancesWithBalance();

        await this.processTokenPerformances(tokenPerformances);
    }

    private processTokenPerformances(tokenPerformances: TokenPerformance[]) {
        //  To Do: logic when to sell and how much
        console.log("Deciding when to sell and how much...");
        const runningProcesses = this.runningProcesses;
        // remove running processes from tokenPerformances
        tokenPerformances = tokenPerformances.filter(
            (tp) => !runningProcesses.has(tp.tokenAddress)
        );

        // start the process in the sonar backend
        tokenPerformances.forEach(async (tokenPerformance) => {
            const tokenProvider = new TokenProvider(
                tokenPerformance.tokenAddress,
                this.walletProvider
            );
            const shouldTrade = await tokenProvider.shouldTradeToken();
            if (shouldTrade) {
                const balance = tokenPerformance.balance;
                const sell_recommender_id = tokenPerformance.recommenderId;
                const tokenAddress = tokenPerformance.tokenAddress;
                const process = await this.startProcessInTheSonarBackend(
                    tokenAddress,
                    balance,
                    sell_recommender_id
                );
                if (process) {
                    this.runningProcesses.add(tokenAddress);
                }
            }
        });
    }

    private async startProcessInTheSonarBackend(
        tokenAddress: string,
        balance: number,
        sell_recommender_id: string
    ) {
        try {
            const message = JSON.stringify({
                tokenAddress,
                balance,
                sell_recommender_id,
            });
            const response = await fetch(
                `${this.sonarBe}/api/simulation/sell`,
                {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        Authorization: `Bearer ${this.sonarBeToken}`,
                    },
                    body: message,
                }
            );

            if (!response.ok) {
                console.error(
                    `Failed to send message to process token ${tokenAddress}`
                );
                return;
            }

            const result = await response.json();
            console.log("Received response:", result);
            console.log(`Sent message to process token ${tokenAddress}`);

            return result;
        } catch (error) {
            console.error(
                `Error sending message to process token ${tokenAddress}:`,
                error
            );
            return null;
        }
    }

    private stopProcessInTheSonarBackend(tokenAddress: string) {
        try {
            return fetch(
                `${this.sonarBe}/api/simulation/sell/${tokenAddress}`,
                {
                    method: "GET",
                    headers: {
                        Authorization: `Bearer ${this.sonarBeToken}`,
                    },
                }
            );
        } catch (error) {
            console.error(
                `Error stopping process for token ${tokenAddress}:`,
                error
            );
        }
    }

    async updateSellDetails(
        tokenAddress: string,
        recommenderId: string,
        sellTimeStamp: string,
        sellDetails: SellDetails,
        isSimulation: boolean,
        tokenProvider: TokenProvider
    ) {
        const recommender =
            await this.trustScoreDb.getOrCreateRecommenderWithTelegramId(
                recommenderId
            );
        const processedData: ProcessedTokenData =
            await tokenProvider.getProcessedTokenData();
        const prices = await this.walletProvider.fetchPrices(null);
        const solPrice = prices.solana.usd;
        const sellSol = sellDetails.sell_amount / parseFloat(solPrice);
        const sell_value_usd =
            sellDetails.sell_amount * processedData.tradeData.price;
        const trade = await this.trustScoreDb.getLatestTradePerformance(
            tokenAddress,
            recommender.id,
            isSimulation
        );
        const buyTimeStamp = trade.buy_timeStamp;
        const marketCap =
            processedData.dexScreenerData.pairs[0]?.marketCap || 0;
        const liquidity =
            processedData.dexScreenerData.pairs[0]?.liquidity.usd || 0;
        const sell_price = processedData.tradeData.price;
        const profit_usd = sell_value_usd - trade.buy_value_usd;
        const profit_percent = (profit_usd / trade.buy_value_usd) * 100;

        const market_cap_change = marketCap - trade.buy_market_cap;
        const liquidity_change = liquidity - trade.buy_liquidity;

        const isRapidDump = await this.isRapidDump(tokenAddress, tokenProvider);

        const sellDetailsData = {
            sell_price: sell_price,
            sell_timeStamp: sellTimeStamp,
            sell_amount: sellDetails.sell_amount,
            received_sol: sellSol,
            sell_value_usd: sell_value_usd,
            profit_usd: profit_usd,
            profit_percent: profit_percent,
            sell_market_cap: marketCap,
            market_cap_change: market_cap_change,
            sell_liquidity: liquidity,
            liquidity_change: liquidity_change,
            rapidDump: isRapidDump,
            sell_recommender_id: sellDetails.sell_recommender_id || null,
        };
        this.trustScoreDb.updateTradePerformanceOnSell(
            tokenAddress,
            recommender.id,
            buyTimeStamp,
            sellDetailsData,
            isSimulation
        );

        // If the trade is a simulation update the balance
        const oldBalance = this.trustScoreDb.getTokenBalance(tokenAddress);
        const tokenBalance = oldBalance - sellDetails.sell_amount;
        this.trustScoreDb.updateTokenBalance(tokenAddress, tokenBalance);
        // generate some random hash for simulations
        const hash = Math.random().toString(36).substring(7);
        const transaction = {
            tokenAddress: tokenAddress,
            type: "sell",
            transactionHash: hash,
            amount: sellDetails.sell_amount,
            price: processedData.tradeData.price,
            isSimulation: true,
            timestamp: new Date().toISOString(),
        };
        this.trustScoreDb.addTransaction(transaction);
        this.updateTradeInBe(
            tokenAddress,
            recommender.id,
            recommender.telegramId,
            sellDetailsData,
            tokenBalance
        );

        return sellDetailsData;
    }
    async isRapidDump(
        tokenAddress: string,
        tokenProvider: TokenProvider
    ): Promise<boolean> {
        const processedData: ProcessedTokenData =
            await tokenProvider.getProcessedTokenData();
        console.log(`Fetched processed token data for token: ${tokenAddress}`);

        return processedData.tradeData.trade_24h_change_percent < -50;
    }

    async delay(ms: number) {
        return new Promise((resolve) => setTimeout(resolve, ms));
    }

    async updateTradeInBe(
        tokenAddress: string,
        recommenderId: string,
        username: string,
        data: SellDetails,
        balanceLeft: number,
        retries = 3,
        delayMs = 2000
    ) {
        for (let attempt = 1; attempt <= retries; attempt++) {
            try {
                await fetch(
                    `${this.backend}/api/updaters/updateTradePerformance`,
                    {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            Authorization: `Bearer ${this.backendToken}`,
                        },
                        body: JSON.stringify({
                            tokenAddress: tokenAddress,
                            tradeData: data,
                            recommenderId: recommenderId,
                            username: username,
                            isSimulation: true,
                            balanceLeft: balanceLeft,
                        }),
                    }
                );
                // If the request is successful, exit the loop
                return;
            } catch (error) {
                console.error(
                    `Attempt ${attempt} failed: Error creating trade in backend`,
                    error
                );
                if (attempt < retries) {
                    console.log(`Retrying in ${delayMs} ms...`);
                    await this.delay(delayMs); // Wait for the specified delay before retrying
                } else {
                    console.error("All attempts failed.");
                }
            }
        }
    }
}

// SellDecision interface
interface SellDecision {
    tokenPerformance: TokenPerformance;
    amountToSell: number;
    sell_recommender_id: string | null;
}
