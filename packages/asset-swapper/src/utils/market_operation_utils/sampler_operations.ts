import { ChainId } from '@0x/contract-addresses';
import { LimitOrderFields } from '@0x/protocol-utils';
import { BigNumber } from '@0x/utils';
import * as _ from 'lodash';

import { SamplerCallResult, SignedNativeOrder } from '../../types';
import { ERC20BridgeSamplerContract } from '../../wrappers';

import { BalancerPoolsCache } from './balancer_utils';
import { BancorService } from './bancor_service';
import {
    getCurveLikeInfosForPair,
    getDodoV2Offsets,
    getKyberOffsets,
    getShellsForPair,
    isAllowedKyberReserveId,
    isBadTokenForSource,
    isValidAddress,
    uniswapV2LikeRouterAddress,
} from './bridge_source_utils';
import {
    BANCOR_REGISTRY_BY_CHAIN_ID,
    DODO_CONFIG_BY_CHAIN_ID,
    DODOV2_FACTORIES_BY_CHAIN_ID,
    KYBER_CONFIG_BY_CHAIN_ID,
    LINKSWAP_ROUTER_BY_CHAIN_ID,
    LIQUIDITY_PROVIDER_REGISTRY,
    MAKER_PSM_INFO_BY_CHAIN_ID,
    MAX_UINT256,
    MOONISWAP_REGISTRIES_BY_CHAIN_ID,
    MSTABLE_ROUTER_BY_CHAIN_ID,
    NATIVE_FEE_TOKEN_BY_CHAIN_ID,
    NULL_ADDRESS,
    NULL_BYTES,
    OASIS_ROUTER_BY_CHAIN_ID,
    SELL_SOURCE_FILTER_BY_CHAIN_ID,
    TOKENS,
    UNISWAPV1_ROUTER_BY_CHAIN_ID,
    ZERO_AMOUNT,
} from './constants';
import { CreamPoolsCache } from './cream_utils';
import { getLiquidityProvidersForPair } from './liquidity_provider_utils';
import { getIntermediateTokens } from './multihop_utils';
import { SamplerContractOperation } from './sampler_contract_operation';
import { SourceFilters } from './source_filters';
import {
    BalancerFillData,
    BancorFillData,
    BatchedOperation,
    CurveFillData,
    CurveInfo,
    DexSample,
    DODOFillData,
    ERC20BridgeSource,
    GenericRouterFillData,
    HopInfo,
    KyberFillData,
    KyberSamplerOpts,
    LiquidityProviderFillData,
    LiquidityProviderRegistry,
    MakerPsmFillData,
    MooniswapFillData,
    MultiHopFillData,
    PsmInfo,
    ShellFillData,
    SourceQuoteOperation,
    TokenAdjacencyGraph,
    UniswapV2FillData,
} from './types';

/**
 * Source filters for `getTwoHopBuyQuotes()` and `getTwoHopSellQuotes()`.
 */
export const TWO_HOP_SOURCE_FILTERS = SourceFilters.all().exclude([
    ERC20BridgeSource.MultiHop,
    ERC20BridgeSource.Native,
]);
/**
 * Source filters for `getSellQuotes()` and `getBuyQuotes()`.
 */
export const BATCH_SOURCE_FILTERS = SourceFilters.all().exclude([ERC20BridgeSource.MultiHop, ERC20BridgeSource.Native]);

// tslint:disable:no-inferred-empty-object-type no-unbound-method

/**
 * Composable operations that can be batched in a single transaction,
 * for use with `DexOrderSampler.executeAsync()`.
 */
export class SamplerOperations {
    protected _bancorService?: BancorService;
    public static constant<T>(result: T): BatchedOperation<T> {
        return {
            encodeCall: () => '0x',
            handleCallResults: _callResults => result,
            handleRevert: _callResults => result,
        };
    }

    constructor(
        public readonly chainId: ChainId,
        protected readonly _samplerContract: ERC20BridgeSamplerContract,
        public readonly balancerPoolsCache: BalancerPoolsCache = new BalancerPoolsCache(),
        public readonly creamPoolsCache: CreamPoolsCache = new CreamPoolsCache(),
        protected readonly tokenAdjacencyGraph: TokenAdjacencyGraph = { default: [] },
        public readonly liquidityProviderRegistry: LiquidityProviderRegistry = LIQUIDITY_PROVIDER_REGISTRY,
        bancorServiceFn: () => Promise<BancorService | undefined> = async () => undefined,
    ) {
        // Initialize the Bancor service, fetching paths in the background
        bancorServiceFn()
            .then(service => (this._bancorService = service))
            .catch(/* do nothing */);
    }

    public getTokenDecimals(tokens: string[]): BatchedOperation<BigNumber[]> {
        return new SamplerContractOperation({
            source: ERC20BridgeSource.Native,
            contract: this._samplerContract,
            function: this._samplerContract.getTokenDecimals,
            params: [tokens],
        });
    }

    public isAddressContract(address: string): BatchedOperation<boolean> {
        return {
            encodeCall: () => this._samplerContract.isContract(address).getABIEncodedTransactionData(),
            handleCallResults: (callResults: string) =>
                this._samplerContract.getABIDecodedReturnData<boolean>('isContract', callResults),
            handleRevert: () => {
                /* should never happen */
                throw new Error('Invalid address for isAddressContract');
            },
        };
    }

    public getLimitOrderFillableTakerAmounts(
        orders: SignedNativeOrder[],
        exchangeAddress: string,
    ): BatchedOperation<BigNumber[]> {
        return new SamplerContractOperation({
            source: ERC20BridgeSource.Native,
            contract: this._samplerContract,
            function: this._samplerContract.getLimitOrderFillableTakerAssetAmounts,
            // tslint:disable-next-line:no-unnecessary-type-assertion
            params: [orders.map(o => o.order as LimitOrderFields), orders.map(o => o.signature), exchangeAddress],
        });
    }

    public getLimitOrderFillableMakerAmounts(
        orders: SignedNativeOrder[],
        exchangeAddress: string,
    ): BatchedOperation<BigNumber[]> {
        return new SamplerContractOperation({
            source: ERC20BridgeSource.Native,
            contract: this._samplerContract,
            function: this._samplerContract.getLimitOrderFillableMakerAssetAmounts,
            // tslint:disable-next-line:no-unnecessary-type-assertion
            params: [orders.map(o => o.order as LimitOrderFields), orders.map(o => o.signature), exchangeAddress],
        });
    }

    public getKyberSellQuotes(
        kyberOpts: KyberSamplerOpts,
        reserveOffset: BigNumber,
        makerToken: string,
        takerToken: string,
        takerFillAmounts: BigNumber[],
    ): SourceQuoteOperation {
        return new SamplerContractOperation({
            source: ERC20BridgeSource.Kyber,
            contract: this._samplerContract,
            function: this._samplerContract.sampleSellsFromKyberNetwork,
            params: [{ ...kyberOpts, reserveOffset, hint: NULL_BYTES }, takerToken, makerToken, takerFillAmounts],
            callback: (callResults: string, fillData: KyberFillData): BigNumber[] => {
                const [reserveId, hint, samples] = this._samplerContract.getABIDecodedReturnData<
                    [string, string, BigNumber[]]
                >('sampleSellsFromKyberNetwork', callResults);
                fillData.hint = hint;
                fillData.reserveId = reserveId;
                fillData.networkProxy = kyberOpts.networkProxy;
                return isAllowedKyberReserveId(reserveId) ? samples : [];
            },
        });
    }

    public getKyberBuyQuotes(
        kyberOpts: KyberSamplerOpts,
        reserveOffset: BigNumber,
        makerToken: string,
        takerToken: string,
        makerFillAmounts: BigNumber[],
    ): SourceQuoteOperation {
        return new SamplerContractOperation({
            source: ERC20BridgeSource.Kyber,
            contract: this._samplerContract,
            function: this._samplerContract.sampleBuysFromKyberNetwork,
            params: [{ ...kyberOpts, reserveOffset, hint: NULL_BYTES }, takerToken, makerToken, makerFillAmounts],
            callback: (callResults: string, fillData: KyberFillData): BigNumber[] => {
                const [reserveId, hint, samples] = this._samplerContract.getABIDecodedReturnData<
                    [string, string, BigNumber[]]
                >('sampleBuysFromKyberNetwork', callResults);
                fillData.hint = hint;
                fillData.reserveId = reserveId;
                fillData.networkProxy = kyberOpts.networkProxy;
                return isAllowedKyberReserveId(reserveId) ? samples : [];
            },
        });
    }

    public getUniswapSellQuotes(
        router: string,
        makerToken: string,
        takerToken: string,
        takerFillAmounts: BigNumber[],
    ): SourceQuoteOperation<GenericRouterFillData> {
        // Uniswap uses ETH instead of WETH, represented by address(0)
        const uniswapTakerToken = takerToken === NATIVE_FEE_TOKEN_BY_CHAIN_ID[this.chainId] ? NULL_ADDRESS : takerToken;
        const uniswapMakerToken = makerToken === NATIVE_FEE_TOKEN_BY_CHAIN_ID[this.chainId] ? NULL_ADDRESS : makerToken;
        return new SamplerContractOperation({
            source: ERC20BridgeSource.Uniswap,
            fillData: { router },
            contract: this._samplerContract,
            function: this._samplerContract.sampleSellsFromUniswap,
            params: [router, uniswapTakerToken, uniswapMakerToken, takerFillAmounts],
        });
    }

    public getUniswapBuyQuotes(
        router: string,
        makerToken: string,
        takerToken: string,
        makerFillAmounts: BigNumber[],
    ): SourceQuoteOperation<GenericRouterFillData> {
        // Uniswap uses ETH instead of WETH, represented by address(0)
        const uniswapTakerToken = takerToken === NATIVE_FEE_TOKEN_BY_CHAIN_ID[this.chainId] ? NULL_ADDRESS : takerToken;
        const uniswapMakerToken = makerToken === NATIVE_FEE_TOKEN_BY_CHAIN_ID[this.chainId] ? NULL_ADDRESS : makerToken;
        return new SamplerContractOperation({
            source: ERC20BridgeSource.Uniswap,
            fillData: { router },
            contract: this._samplerContract,
            function: this._samplerContract.sampleBuysFromUniswap,
            params: [router, uniswapTakerToken, uniswapMakerToken, makerFillAmounts],
        });
    }

    public getUniswapV2SellQuotes(
        router: string,
        tokenAddressPath: string[],
        takerFillAmounts: BigNumber[],
        source: ERC20BridgeSource = ERC20BridgeSource.UniswapV2,
    ): SourceQuoteOperation<UniswapV2FillData> {
        return new SamplerContractOperation({
            source,
            fillData: { tokenAddressPath, router },
            contract: this._samplerContract,
            function: this._samplerContract.sampleSellsFromUniswapV2,
            params: [router, tokenAddressPath, takerFillAmounts],
        });
    }

    public getUniswapV2BuyQuotes(
        router: string,
        tokenAddressPath: string[],
        makerFillAmounts: BigNumber[],
        source: ERC20BridgeSource = ERC20BridgeSource.UniswapV2,
    ): SourceQuoteOperation<UniswapV2FillData> {
        return new SamplerContractOperation({
            source,
            fillData: { tokenAddressPath, router },
            contract: this._samplerContract,
            function: this._samplerContract.sampleBuysFromUniswapV2,
            params: [router, tokenAddressPath, makerFillAmounts],
        });
    }

    public getLiquidityProviderSellQuotes(
        providerAddress: string,
        makerToken: string,
        takerToken: string,
        takerFillAmounts: BigNumber[],
    ): SourceQuoteOperation<LiquidityProviderFillData> {
        return new SamplerContractOperation({
            source: ERC20BridgeSource.LiquidityProvider,
            fillData: {
                poolAddress: providerAddress,
                gasCost: this.liquidityProviderRegistry[providerAddress].gasCost,
            },
            contract: this._samplerContract,
            function: this._samplerContract.sampleSellsFromLiquidityProvider,
            params: [providerAddress, takerToken, makerToken, takerFillAmounts],
        });
    }

    public getLiquidityProviderBuyQuotes(
        providerAddress: string,
        makerToken: string,
        takerToken: string,
        makerFillAmounts: BigNumber[],
    ): SourceQuoteOperation<LiquidityProviderFillData> {
        return new SamplerContractOperation({
            source: ERC20BridgeSource.LiquidityProvider,
            fillData: {
                poolAddress: providerAddress,
                gasCost: this.liquidityProviderRegistry[providerAddress].gasCost,
            },
            contract: this._samplerContract,
            function: this._samplerContract.sampleBuysFromLiquidityProvider,
            params: [providerAddress, takerToken, makerToken, makerFillAmounts],
        });
    }

    public getEth2DaiSellQuotes(
        router: string,
        makerToken: string,
        takerToken: string,
        takerFillAmounts: BigNumber[],
    ): SourceQuoteOperation<GenericRouterFillData> {
        return new SamplerContractOperation({
            source: ERC20BridgeSource.Eth2Dai,
            fillData: { router },
            contract: this._samplerContract,
            function: this._samplerContract.sampleSellsFromEth2Dai,
            params: [router, takerToken, makerToken, takerFillAmounts],
        });
    }

    public getEth2DaiBuyQuotes(
        router: string,
        makerToken: string,
        takerToken: string,
        makerFillAmounts: BigNumber[],
    ): SourceQuoteOperation<GenericRouterFillData> {
        return new SamplerContractOperation({
            source: ERC20BridgeSource.Eth2Dai,
            fillData: { router },
            contract: this._samplerContract,
            function: this._samplerContract.sampleBuysFromEth2Dai,
            params: [router, takerToken, makerToken, makerFillAmounts],
        });
    }

    public getCurveSellQuotes(
        pool: CurveInfo,
        fromTokenIdx: number,
        toTokenIdx: number,
        takerFillAmounts: BigNumber[],
        source: ERC20BridgeSource = ERC20BridgeSource.Curve,
    ): SourceQuoteOperation<CurveFillData> {
        return new SamplerContractOperation({
            source,
            fillData: {
                pool,
                fromTokenIdx,
                toTokenIdx,
            },
            contract: this._samplerContract,
            function: this._samplerContract.sampleSellsFromCurve,
            params: [
                {
                    poolAddress: pool.poolAddress,
                    sellQuoteFunctionSelector: pool.sellQuoteFunctionSelector,
                    buyQuoteFunctionSelector: pool.buyQuoteFunctionSelector,
                },
                new BigNumber(fromTokenIdx),
                new BigNumber(toTokenIdx),
                takerFillAmounts,
            ],
        });
    }

    public getCurveBuyQuotes(
        pool: CurveInfo,
        fromTokenIdx: number,
        toTokenIdx: number,
        makerFillAmounts: BigNumber[],
        source: ERC20BridgeSource = ERC20BridgeSource.Curve,
    ): SourceQuoteOperation<CurveFillData> {
        return new SamplerContractOperation({
            source,
            fillData: {
                pool,
                fromTokenIdx,
                toTokenIdx,
            },
            contract: this._samplerContract,
            function: this._samplerContract.sampleBuysFromCurve,
            params: [
                {
                    poolAddress: pool.poolAddress,
                    sellQuoteFunctionSelector: pool.sellQuoteFunctionSelector,
                    buyQuoteFunctionSelector: pool.buyQuoteFunctionSelector,
                },
                new BigNumber(fromTokenIdx),
                new BigNumber(toTokenIdx),
                makerFillAmounts,
            ],
        });
    }

    public getBalancerSellQuotes(
        poolAddress: string,
        makerToken: string,
        takerToken: string,
        takerFillAmounts: BigNumber[],
        source: ERC20BridgeSource,
    ): SourceQuoteOperation<BalancerFillData> {
        return new SamplerContractOperation({
            source,
            fillData: { poolAddress },
            contract: this._samplerContract,
            function: this._samplerContract.sampleSellsFromBalancer,
            params: [poolAddress, takerToken, makerToken, takerFillAmounts],
        });
    }

    public getBalancerBuyQuotes(
        poolAddress: string,
        makerToken: string,
        takerToken: string,
        makerFillAmounts: BigNumber[],
        source: ERC20BridgeSource,
    ): SourceQuoteOperation<BalancerFillData> {
        return new SamplerContractOperation({
            source,
            fillData: { poolAddress },
            contract: this._samplerContract,
            function: this._samplerContract.sampleBuysFromBalancer,
            params: [poolAddress, takerToken, makerToken, makerFillAmounts],
        });
    }

    public async getBalancerSellQuotesOffChainAsync(
        makerToken: string,
        takerToken: string,
        _takerFillAmounts: BigNumber[],
    ): Promise<Array<Array<DexSample<BalancerFillData>>>> {
        // Prime the cache but do not sample off chain
        await this.balancerPoolsCache.getPoolsForPairAsync(takerToken, makerToken);
        return [];
        // return pools.map(pool =>
        //    takerFillAmounts.map(amount => ({
        //        source: ERC20BridgeSource.Balancer,
        //        output: computeBalancerSellQuote(pool, amount),
        //        input: amount,
        //        fillData: { poolAddress: pool.id },
        //    })),
        // );
    }

    public async getBalancerBuyQuotesOffChainAsync(
        makerToken: string,
        takerToken: string,
        _makerFillAmounts: BigNumber[],
    ): Promise<Array<Array<DexSample<BalancerFillData>>>> {
        // Prime the pools but do not sample off chain
        // Prime the cache but do not sample off chain
        await this.balancerPoolsCache.getPoolsForPairAsync(takerToken, makerToken);
        return [];
        // return pools.map(pool =>
        //    makerFillAmounts.map(amount => ({
        //        source: ERC20BridgeSource.Balancer,
        //        output: computeBalancerBuyQuote(pool, amount),
        //        input: amount,
        //        fillData: { poolAddress: pool.id },
        //    })),
        // );
    }

    public async getCreamSellQuotesOffChainAsync(
        makerToken: string,
        takerToken: string,
        _takerFillAmounts: BigNumber[],
    ): Promise<Array<Array<DexSample<BalancerFillData>>>> {
        // Prime the cache but do not sample off chain
        await this.creamPoolsCache.getPoolsForPairAsync(takerToken, makerToken);
        return [];
        // return pools.map(pool =>
        //     takerFillAmounts.map(amount => ({
        //         source: ERC20BridgeSource.Cream,
        //         output: computeBalancerSellQuote(pool, amount),
        //         input: amount,
        //         fillData: { poolAddress: pool.id },
        //     })),
        // );
    }

    public async getCreamBuyQuotesOffChainAsync(
        makerToken: string,
        takerToken: string,
        _makerFillAmounts: BigNumber[],
    ): Promise<Array<Array<DexSample<BalancerFillData>>>> {
        // Prime the cache but do not sample off chain
        await this.creamPoolsCache.getPoolsForPairAsync(takerToken, makerToken);
        return [];
        // return pools.map(pool =>
        //    makerFillAmounts.map(amount => ({
        //        source: ERC20BridgeSource.Cream,
        //        output: computeBalancerBuyQuote(pool, amount),
        //        input: amount,
        //        fillData: { poolAddress: pool.id },
        //    })),
        // );
    }

    public getMStableSellQuotes(
        router: string,
        makerToken: string,
        takerToken: string,
        takerFillAmounts: BigNumber[],
    ): SourceQuoteOperation<GenericRouterFillData> {
        return new SamplerContractOperation({
            source: ERC20BridgeSource.MStable,
            fillData: { router },
            contract: this._samplerContract,
            function: this._samplerContract.sampleSellsFromMStable,
            params: [router, takerToken, makerToken, takerFillAmounts],
        });
    }

    public getMStableBuyQuotes(
        router: string,
        makerToken: string,
        takerToken: string,
        makerFillAmounts: BigNumber[],
    ): SourceQuoteOperation<GenericRouterFillData> {
        return new SamplerContractOperation({
            source: ERC20BridgeSource.MStable,
            fillData: { router },
            contract: this._samplerContract,
            function: this._samplerContract.sampleBuysFromMStable,
            params: [router, takerToken, makerToken, makerFillAmounts],
        });
    }

    public getBancorSellQuotes(
        registry: string,
        makerToken: string,
        takerToken: string,
        takerFillAmounts: BigNumber[],
    ): SourceQuoteOperation<BancorFillData> {
        const paths = this._bancorService ? this._bancorService.getPaths(takerToken, makerToken) : [];
        return new SamplerContractOperation({
            source: ERC20BridgeSource.Bancor,
            contract: this._samplerContract,
            function: this._samplerContract.sampleSellsFromBancor,
            params: [{ registry, paths }, takerToken, makerToken, takerFillAmounts],
            callback: (callResults: string, fillData: BancorFillData): BigNumber[] => {
                const [networkAddress, path, samples] = this._samplerContract.getABIDecodedReturnData<
                    [string, string[], BigNumber[]]
                >('sampleSellsFromBancor', callResults);
                fillData.networkAddress = networkAddress;
                fillData.path = path;
                return samples;
            },
        });
    }

    // Unimplemented
    public getBancorBuyQuotes(
        registry: string,
        makerToken: string,
        takerToken: string,
        makerFillAmounts: BigNumber[],
    ): SourceQuoteOperation<BancorFillData> {
        return new SamplerContractOperation({
            source: ERC20BridgeSource.Bancor,
            contract: this._samplerContract,
            function: this._samplerContract.sampleBuysFromBancor,
            params: [{ registry, paths: [] }, takerToken, makerToken, makerFillAmounts],
            callback: (callResults: string, fillData: BancorFillData): BigNumber[] => {
                const [networkAddress, path, samples] = this._samplerContract.getABIDecodedReturnData<
                    [string, string[], BigNumber[]]
                >('sampleBuysFromBancor', callResults);
                fillData.networkAddress = networkAddress;
                fillData.path = path;
                return samples;
            },
        });
    }

    public getMooniswapSellQuotes(
        registry: string,
        makerToken: string,
        takerToken: string,
        takerFillAmounts: BigNumber[],
    ): SourceQuoteOperation<MooniswapFillData> {
        // Mooniswap uses ETH instead of WETH, represented by address(0)
        const mooniswapTakerToken =
            takerToken === NATIVE_FEE_TOKEN_BY_CHAIN_ID[this.chainId] ? NULL_ADDRESS : takerToken;
        const mooniswapMakerToken =
            makerToken === NATIVE_FEE_TOKEN_BY_CHAIN_ID[this.chainId] ? NULL_ADDRESS : makerToken;
        return new SamplerContractOperation({
            source: ERC20BridgeSource.Mooniswap,
            contract: this._samplerContract,
            function: this._samplerContract.sampleSellsFromMooniswap,
            params: [registry, mooniswapTakerToken, mooniswapMakerToken, takerFillAmounts],
            callback: (callResults: string, fillData: MooniswapFillData): BigNumber[] => {
                const [poolAddress, samples] = this._samplerContract.getABIDecodedReturnData<[string, BigNumber[]]>(
                    'sampleSellsFromMooniswap',
                    callResults,
                );
                fillData.poolAddress = poolAddress;
                return samples;
            },
        });
    }

    public getMooniswapBuyQuotes(
        registry: string,
        makerToken: string,
        takerToken: string,
        makerFillAmounts: BigNumber[],
    ): SourceQuoteOperation<MooniswapFillData> {
        // Mooniswap uses ETH instead of WETH, represented by address(0)
        const mooniswapTakerToken =
            takerToken === NATIVE_FEE_TOKEN_BY_CHAIN_ID[this.chainId] ? NULL_ADDRESS : takerToken;
        const mooniswapMakerToken =
            makerToken === NATIVE_FEE_TOKEN_BY_CHAIN_ID[this.chainId] ? NULL_ADDRESS : makerToken;
        return new SamplerContractOperation({
            source: ERC20BridgeSource.Mooniswap,
            contract: this._samplerContract,
            function: this._samplerContract.sampleBuysFromMooniswap,
            params: [registry, mooniswapTakerToken, mooniswapMakerToken, makerFillAmounts],
            callback: (callResults: string, fillData: MooniswapFillData): BigNumber[] => {
                const [poolAddress, samples] = this._samplerContract.getABIDecodedReturnData<[string, BigNumber[]]>(
                    'sampleBuysFromMooniswap',
                    callResults,
                );
                fillData.poolAddress = poolAddress;
                return samples;
            },
        });
    }

    public getTwoHopSellQuotes(
        sources: ERC20BridgeSource[],
        makerToken: string,
        takerToken: string,
        sellAmount: BigNumber,
    ): BatchedOperation<Array<DexSample<MultiHopFillData>>> {
        const _sources = TWO_HOP_SOURCE_FILTERS.getAllowed(sources);
        if (_sources.length === 0) {
            return SamplerOperations.constant([]);
        }
        const intermediateTokens = getIntermediateTokens(makerToken, takerToken, this.tokenAdjacencyGraph);
        const subOps = intermediateTokens.map(intermediateToken => {
            const firstHopOps = this._getSellQuoteOperations(_sources, intermediateToken, takerToken, [ZERO_AMOUNT]);
            const secondHopOps = this._getSellQuoteOperations(_sources, makerToken, intermediateToken, [ZERO_AMOUNT]);
            return new SamplerContractOperation({
                contract: this._samplerContract,
                source: ERC20BridgeSource.MultiHop,
                function: this._samplerContract.sampleTwoHopSell,
                params: [firstHopOps.map(op => op.encodeCall()), secondHopOps.map(op => op.encodeCall()), sellAmount],
                fillData: { intermediateToken } as MultiHopFillData, // tslint:disable-line:no-object-literal-type-assertion
                callback: (callResults: string, fillData: MultiHopFillData): BigNumber[] => {
                    const [firstHop, secondHop, buyAmount] = this._samplerContract.getABIDecodedReturnData<
                        [HopInfo, HopInfo, BigNumber]
                    >('sampleTwoHopSell', callResults);
                    // Ensure the hop sources are set even when the buy amount is zero
                    fillData.firstHopSource = firstHopOps[firstHop.sourceIndex.toNumber()];
                    fillData.secondHopSource = secondHopOps[secondHop.sourceIndex.toNumber()];
                    if (buyAmount.isZero()) {
                        return [ZERO_AMOUNT];
                    }
                    fillData.firstHopSource.handleCallResults(firstHop.returnData);
                    fillData.secondHopSource.handleCallResults(secondHop.returnData);
                    return [buyAmount];
                },
            });
        });
        return this._createBatch(
            subOps,
            (samples: BigNumber[][]) => {
                return subOps.map((op, i) => {
                    return {
                        source: op.source,
                        output: samples[i][0],
                        input: sellAmount,
                        fillData: op.fillData,
                    };
                });
            },
            () => [],
        );
    }

    public getTwoHopBuyQuotes(
        sources: ERC20BridgeSource[],
        makerToken: string,
        takerToken: string,
        buyAmount: BigNumber,
    ): BatchedOperation<Array<DexSample<MultiHopFillData>>> {
        const _sources = TWO_HOP_SOURCE_FILTERS.getAllowed(sources);
        if (_sources.length === 0) {
            return SamplerOperations.constant([]);
        }
        const intermediateTokens = getIntermediateTokens(makerToken, takerToken, this.tokenAdjacencyGraph);
        const subOps = intermediateTokens.map(intermediateToken => {
            const firstHopOps = this._getBuyQuoteOperations(_sources, intermediateToken, takerToken, [
                new BigNumber(0),
            ]);
            const secondHopOps = this._getBuyQuoteOperations(_sources, makerToken, intermediateToken, [
                new BigNumber(0),
            ]);
            return new SamplerContractOperation({
                contract: this._samplerContract,
                source: ERC20BridgeSource.MultiHop,
                function: this._samplerContract.sampleTwoHopBuy,
                params: [firstHopOps.map(op => op.encodeCall()), secondHopOps.map(op => op.encodeCall()), buyAmount],
                fillData: { intermediateToken } as MultiHopFillData, // tslint:disable-line:no-object-literal-type-assertion
                callback: (callResults: string, fillData: MultiHopFillData): BigNumber[] => {
                    const [firstHop, secondHop, sellAmount] = this._samplerContract.getABIDecodedReturnData<
                        [HopInfo, HopInfo, BigNumber]
                    >('sampleTwoHopBuy', callResults);
                    if (sellAmount.isEqualTo(MAX_UINT256)) {
                        return [sellAmount];
                    }
                    fillData.firstHopSource = firstHopOps[firstHop.sourceIndex.toNumber()];
                    fillData.secondHopSource = secondHopOps[secondHop.sourceIndex.toNumber()];
                    fillData.firstHopSource.handleCallResults(firstHop.returnData);
                    fillData.secondHopSource.handleCallResults(secondHop.returnData);
                    return [sellAmount];
                },
            });
        });
        return this._createBatch(
            subOps,
            (samples: BigNumber[][]) => {
                return subOps.map((op, i) => {
                    return {
                        source: op.source,
                        output: samples[i][0],
                        input: buyAmount,
                        fillData: op.fillData,
                    };
                });
            },
            () => [],
        );
    }

    public getShellSellQuotes(
        poolAddress: string,
        makerToken: string,
        takerToken: string,
        takerFillAmounts: BigNumber[],
    ): SourceQuoteOperation<ShellFillData> {
        return new SamplerContractOperation({
            source: ERC20BridgeSource.Shell,
            fillData: { poolAddress },
            contract: this._samplerContract,
            function: this._samplerContract.sampleSellsFromShell,
            params: [poolAddress, takerToken, makerToken, takerFillAmounts],
        });
    }

    public getShellBuyQuotes(
        poolAddress: string,
        makerToken: string,
        takerToken: string,
        makerFillAmounts: BigNumber[],
    ): SourceQuoteOperation {
        return new SamplerContractOperation({
            source: ERC20BridgeSource.Shell,
            fillData: { poolAddress },
            contract: this._samplerContract,
            function: this._samplerContract.sampleBuysFromShell,
            params: [poolAddress, takerToken, makerToken, makerFillAmounts],
        });
    }

    public getDODOSellQuotes(
        opts: { registry: string; helper: string },
        makerToken: string,
        takerToken: string,
        takerFillAmounts: BigNumber[],
    ): SourceQuoteOperation<DODOFillData> {
        return new SamplerContractOperation({
            source: ERC20BridgeSource.Dodo,
            contract: this._samplerContract,
            function: this._samplerContract.sampleSellsFromDODO,
            params: [opts, takerToken, makerToken, takerFillAmounts],
            callback: (callResults: string, fillData: DODOFillData): BigNumber[] => {
                const [isSellBase, pool, samples] = this._samplerContract.getABIDecodedReturnData<
                    [boolean, string, BigNumber[]]
                >('sampleSellsFromDODO', callResults);
                fillData.isSellBase = isSellBase;
                fillData.poolAddress = pool;
                fillData.helperAddress = opts.helper;
                return samples;
            },
        });
    }

    public getDODOBuyQuotes(
        opts: { registry: string; helper: string },
        makerToken: string,
        takerToken: string,
        makerFillAmounts: BigNumber[],
    ): SourceQuoteOperation<DODOFillData> {
        return new SamplerContractOperation({
            source: ERC20BridgeSource.Dodo,
            contract: this._samplerContract,
            function: this._samplerContract.sampleBuysFromDODO,
            params: [opts, takerToken, makerToken, makerFillAmounts],
            callback: (callResults: string, fillData: DODOFillData): BigNumber[] => {
                const [isSellBase, pool, samples] = this._samplerContract.getABIDecodedReturnData<
                    [boolean, string, BigNumber[]]
                >('sampleBuysFromDODO', callResults);
                fillData.isSellBase = isSellBase;
                fillData.poolAddress = pool;
                fillData.helperAddress = opts.helper;
                return samples;
            },
        });
    }

    public getDODOV2SellQuotes(
        registry: string,
        offset: BigNumber,
        makerToken: string,
        takerToken: string,
        takerFillAmounts: BigNumber[],
    ): SourceQuoteOperation<DODOFillData> {
        return new SamplerContractOperation({
            source: ERC20BridgeSource.DodoV2,
            contract: this._samplerContract,
            function: this._samplerContract.sampleSellsFromDODOV2,
            params: [registry, offset, takerToken, makerToken, takerFillAmounts],
            callback: (callResults: string, fillData: DODOFillData): BigNumber[] => {
                const [isSellBase, pool, samples] = this._samplerContract.getABIDecodedReturnData<
                    [boolean, string, BigNumber[]]
                >('sampleSellsFromDODOV2', callResults);
                fillData.isSellBase = isSellBase;
                fillData.poolAddress = pool;
                return samples;
            },
        });
    }

    public getDODOV2BuyQuotes(
        registry: string,
        offset: BigNumber,
        makerToken: string,
        takerToken: string,
        makerFillAmounts: BigNumber[],
    ): SourceQuoteOperation<DODOFillData> {
        return new SamplerContractOperation({
            source: ERC20BridgeSource.DodoV2,
            contract: this._samplerContract,
            function: this._samplerContract.sampleBuysFromDODOV2,
            params: [registry, offset, takerToken, makerToken, makerFillAmounts],
            callback: (callResults: string, fillData: DODOFillData): BigNumber[] => {
                const [isSellBase, pool, samples] = this._samplerContract.getABIDecodedReturnData<
                    [boolean, string, BigNumber[]]
                >('sampleSellsFromDODOV2', callResults);
                fillData.isSellBase = isSellBase;
                fillData.poolAddress = pool;
                return samples;
            },
        });
    }

    public getMakerPsmSellQuotes(
        psmInfo: PsmInfo,
        makerToken: string,
        takerToken: string,
        takerFillAmounts: BigNumber[],
    ): SourceQuoteOperation<MakerPsmFillData> {
        return new SamplerContractOperation({
            source: ERC20BridgeSource.MakerPsm,
            fillData: {
                isSellOperation: true,
                takerToken,
                makerToken,
                ...psmInfo,
            },
            contract: this._samplerContract,
            function: this._samplerContract.sampleSellsFromMakerPsm,
            params: [psmInfo, takerToken, makerToken, takerFillAmounts],
        });
    }

    public getMakerPsmBuyQuotes(
        psmInfo: PsmInfo,
        makerToken: string,
        takerToken: string,
        makerFillAmounts: BigNumber[],
    ): SourceQuoteOperation<MakerPsmFillData> {
        return new SamplerContractOperation({
            source: ERC20BridgeSource.MakerPsm,
            fillData: {
                isSellOperation: false,
                takerToken,
                makerToken,
                ...psmInfo,
            },
            contract: this._samplerContract,
            function: this._samplerContract.sampleBuysFromMakerPsm,
            params: [psmInfo, takerToken, makerToken, makerFillAmounts],
        });
    }

    public getMedianSellRate(
        sources: ERC20BridgeSource[],
        makerToken: string,
        takerToken: string,
        takerFillAmount: BigNumber,
    ): BatchedOperation<BigNumber> {
        if (makerToken.toLowerCase() === takerToken.toLowerCase()) {
            return SamplerOperations.constant(new BigNumber(1));
        }
        const subOps = this._getSellQuoteOperations(sources, makerToken, takerToken, [takerFillAmount], {
            default: [],
        });
        return this._createBatch(
            subOps,
            (samples: BigNumber[][]) => {
                if (samples.length === 0) {
                    return ZERO_AMOUNT;
                }
                const flatSortedSamples = samples
                    .reduce((acc, v) => acc.concat(...v))
                    .filter(v => !v.isZero())
                    .sort((a, b) => a.comparedTo(b));
                if (flatSortedSamples.length === 0) {
                    return ZERO_AMOUNT;
                }
                const medianSample = flatSortedSamples[Math.floor(flatSortedSamples.length / 2)];
                return medianSample.div(takerFillAmount);
            },
            () => ZERO_AMOUNT,
        );
    }

    public getSellQuotes(
        sources: ERC20BridgeSource[],
        makerToken: string,
        takerToken: string,
        takerFillAmounts: BigNumber[],
    ): BatchedOperation<DexSample[][]> {
        const subOps = this._getSellQuoteOperations(sources, makerToken, takerToken, takerFillAmounts);
        return this._createBatch(
            subOps,
            (samples: BigNumber[][]) => {
                return subOps.map((op, i) => {
                    return samples[i].map((output, j) => ({
                        source: op.source,
                        output,
                        input: takerFillAmounts[j],
                        fillData: op.fillData,
                    }));
                });
            },
            () => [],
        );
    }

    public getBuyQuotes(
        sources: ERC20BridgeSource[],
        makerToken: string,
        takerToken: string,
        makerFillAmounts: BigNumber[],
    ): BatchedOperation<DexSample[][]> {
        const subOps = this._getBuyQuoteOperations(sources, makerToken, takerToken, makerFillAmounts);
        return this._createBatch(
            subOps,
            (samples: BigNumber[][]) => {
                return subOps.map((op, i) => {
                    return samples[i].map((output, j) => ({
                        source: op.source,
                        output,
                        input: makerFillAmounts[j],
                        fillData: op.fillData,
                    }));
                });
            },
            () => [],
        );
    }

    private _getSellQuoteOperations(
        sources: ERC20BridgeSource[],
        makerToken: string,
        takerToken: string,
        takerFillAmounts: BigNumber[],
        tokenAdjacencyGraph: TokenAdjacencyGraph = this.tokenAdjacencyGraph,
    ): SourceQuoteOperation[] {
        // Find the adjacent tokens in the provided tooken adjacency graph,
        // e.g if this is DAI->USDC we may check for DAI->WETH->USDC
        const intermediateTokens = getIntermediateTokens(makerToken, takerToken, tokenAdjacencyGraph);
        // Drop out MultiHop and Native as we do not query those here.
        const _sources = SELL_SOURCE_FILTER_BY_CHAIN_ID[this.chainId]
            .exclude([ERC20BridgeSource.MultiHop, ERC20BridgeSource.Native])
            .getAllowed(sources);
        const allOps = _.flatten(
            _sources.map(
                (source): SourceQuoteOperation | SourceQuoteOperation[] => {
                    if (isBadTokenForSource(makerToken, source) || isBadTokenForSource(takerToken, source)) {
                        return [];
                    }
                    switch (source) {
                        case ERC20BridgeSource.Eth2Dai:
                            return isValidAddress(OASIS_ROUTER_BY_CHAIN_ID[this.chainId])
                                ? this.getEth2DaiSellQuotes(
                                      OASIS_ROUTER_BY_CHAIN_ID[this.chainId],
                                      makerToken,
                                      takerToken,
                                      takerFillAmounts,
                                  )
                                : [];
                        case ERC20BridgeSource.Uniswap:
                            return isValidAddress(UNISWAPV1_ROUTER_BY_CHAIN_ID[this.chainId])
                                ? this.getUniswapSellQuotes(
                                      UNISWAPV1_ROUTER_BY_CHAIN_ID[this.chainId],
                                      makerToken,
                                      takerToken,
                                      takerFillAmounts,
                                  )
                                : [];
                        case ERC20BridgeSource.UniswapV2:
                        case ERC20BridgeSource.SushiSwap:
                        case ERC20BridgeSource.CryptoCom:
                        case ERC20BridgeSource.PancakeSwap:
                        case ERC20BridgeSource.BakerySwap:
                        case ERC20BridgeSource.KyberDmm:
                            const uniLikeRouter = uniswapV2LikeRouterAddress(this.chainId, source);
                            if (!isValidAddress(uniLikeRouter)) {
                                return [];
                            }
                            return [
                                [takerToken, makerToken],
                                ...intermediateTokens.map(t => [takerToken, t, makerToken]),
                            ].map(path => this.getUniswapV2SellQuotes(uniLikeRouter, path, takerFillAmounts, source));
                        case ERC20BridgeSource.Kyber:
                            return getKyberOffsets().map(offset =>
                                this.getKyberSellQuotes(
                                    KYBER_CONFIG_BY_CHAIN_ID[this.chainId],
                                    offset,
                                    makerToken,
                                    takerToken,
                                    takerFillAmounts,
                                ),
                            );
                        case ERC20BridgeSource.Curve:
                        case ERC20BridgeSource.Swerve:
                        case ERC20BridgeSource.SnowSwap:
                        case ERC20BridgeSource.Nerve:
                        case ERC20BridgeSource.Belt:
                        case ERC20BridgeSource.Ellipsis:
                            return getCurveLikeInfosForPair(this.chainId, takerToken, makerToken, source).map(pool =>
                                this.getCurveSellQuotes(
                                    pool,
                                    pool.tokens.indexOf(takerToken),
                                    pool.tokens.indexOf(makerToken),
                                    takerFillAmounts,
                                    source,
                                ),
                            );
                        case ERC20BridgeSource.LiquidityProvider:
                            return getLiquidityProvidersForPair(
                                this.liquidityProviderRegistry,
                                takerToken,
                                makerToken,
                            ).map(pool =>
                                this.getLiquidityProviderSellQuotes(pool, makerToken, takerToken, takerFillAmounts),
                            );
                        case ERC20BridgeSource.MStable:
                            return isValidAddress(MSTABLE_ROUTER_BY_CHAIN_ID[this.chainId])
                                ? this.getMStableSellQuotes(
                                      MSTABLE_ROUTER_BY_CHAIN_ID[this.chainId],
                                      makerToken,
                                      takerToken,
                                      takerFillAmounts,
                                  )
                                : [];
                        case ERC20BridgeSource.Mooniswap:
                            return [
                                ...MOONISWAP_REGISTRIES_BY_CHAIN_ID[this.chainId]
                                    .filter(r => isValidAddress(r))
                                    .map(registry =>
                                        this.getMooniswapSellQuotes(registry, makerToken, takerToken, takerFillAmounts),
                                    ),
                            ];
                        case ERC20BridgeSource.Balancer:
                            return this.balancerPoolsCache
                                .getCachedPoolAddressesForPair(takerToken, makerToken)!
                                .map(poolAddress =>
                                    this.getBalancerSellQuotes(
                                        poolAddress,
                                        makerToken,
                                        takerToken,
                                        takerFillAmounts,
                                        ERC20BridgeSource.Balancer,
                                    ),
                                );
                        case ERC20BridgeSource.Cream:
                            return this.creamPoolsCache
                                .getCachedPoolAddressesForPair(takerToken, makerToken)!
                                .map(poolAddress =>
                                    this.getBalancerSellQuotes(
                                        poolAddress,
                                        makerToken,
                                        takerToken,
                                        takerFillAmounts,
                                        ERC20BridgeSource.Cream,
                                    ),
                                );
                        case ERC20BridgeSource.Shell:
                            return getShellsForPair(this.chainId, takerToken, makerToken).map(pool =>
                                this.getShellSellQuotes(pool, makerToken, takerToken, takerFillAmounts),
                            );
                        case ERC20BridgeSource.Dodo:
                            if (!isValidAddress(DODO_CONFIG_BY_CHAIN_ID[this.chainId].registry)) {
                                return [];
                            }
                            return this.getDODOSellQuotes(
                                DODO_CONFIG_BY_CHAIN_ID[this.chainId],
                                makerToken,
                                takerToken,
                                takerFillAmounts,
                            );
                        case ERC20BridgeSource.DodoV2:
                            return _.flatten(
                                DODOV2_FACTORIES_BY_CHAIN_ID[this.chainId]
                                    .filter(factory => isValidAddress(factory))
                                    .map(factory =>
                                        getDodoV2Offsets().map(offset =>
                                            this.getDODOV2SellQuotes(
                                                factory,
                                                offset,
                                                makerToken,
                                                takerToken,
                                                takerFillAmounts,
                                            ),
                                        ),
                                    ),
                            );
                        case ERC20BridgeSource.Bancor:
                            if (!isValidAddress(BANCOR_REGISTRY_BY_CHAIN_ID[this.chainId])) {
                                return [];
                            }
                            return this.getBancorSellQuotes(
                                BANCOR_REGISTRY_BY_CHAIN_ID[this.chainId],
                                makerToken,
                                takerToken,
                                takerFillAmounts,
                            );
                        case ERC20BridgeSource.Linkswap:
                            if (!isValidAddress(LINKSWAP_ROUTER_BY_CHAIN_ID[this.chainId])) {
                                return [];
                            }
                            return [
                                [takerToken, makerToken],
                                ...getIntermediateTokens(makerToken, takerToken, {
                                    default: [TOKENS.LINK, TOKENS.WETH],
                                }).map(t => [takerToken, t, makerToken]),
                            ].map(path =>
                                this.getUniswapV2SellQuotes(
                                    LINKSWAP_ROUTER_BY_CHAIN_ID[this.chainId],
                                    path,
                                    takerFillAmounts,
                                    ERC20BridgeSource.Linkswap,
                                ),
                            );
                        case ERC20BridgeSource.MakerPsm:
                            const psmInfo = MAKER_PSM_INFO_BY_CHAIN_ID[this.chainId];
                            if (!isValidAddress(psmInfo.psmAddress)) {
                                return [];
                            }
                            return this.getMakerPsmSellQuotes(psmInfo, makerToken, takerToken, takerFillAmounts);
                        default:
                            throw new Error(`Unsupported sell sample source: ${source}`);
                    }
                },
            ),
        );
        return allOps;
    }

    private _getBuyQuoteOperations(
        sources: ERC20BridgeSource[],
        makerToken: string,
        takerToken: string,
        makerFillAmounts: BigNumber[],
    ): SourceQuoteOperation[] {
        // Find the adjacent tokens in the provided tooken adjacency graph,
        // e.g if this is DAI->USDC we may check for DAI->WETH->USDC
        const intermediateTokens = getIntermediateTokens(makerToken, takerToken, this.tokenAdjacencyGraph);
        const _sources = BATCH_SOURCE_FILTERS.getAllowed(sources);
        return _.flatten(
            _sources.map(
                (source): SourceQuoteOperation | SourceQuoteOperation[] => {
                    switch (source) {
                        case ERC20BridgeSource.Eth2Dai:
                            return isValidAddress(OASIS_ROUTER_BY_CHAIN_ID[this.chainId])
                                ? this.getEth2DaiBuyQuotes(
                                      OASIS_ROUTER_BY_CHAIN_ID[this.chainId],
                                      makerToken,
                                      takerToken,
                                      makerFillAmounts,
                                  )
                                : [];
                        case ERC20BridgeSource.Uniswap:
                            return isValidAddress(UNISWAPV1_ROUTER_BY_CHAIN_ID[this.chainId])
                                ? this.getUniswapBuyQuotes(
                                      UNISWAPV1_ROUTER_BY_CHAIN_ID[this.chainId],
                                      makerToken,
                                      takerToken,
                                      makerFillAmounts,
                                  )
                                : [];
                        case ERC20BridgeSource.UniswapV2:
                        case ERC20BridgeSource.SushiSwap:
                        case ERC20BridgeSource.CryptoCom:
                        case ERC20BridgeSource.PancakeSwap:
                        case ERC20BridgeSource.BakerySwap:
                        case ERC20BridgeSource.KyberDmm:
                            const uniLikeRouter = uniswapV2LikeRouterAddress(this.chainId, source);
                            if (!isValidAddress(uniLikeRouter)) {
                                return [];
                            }
                            return [
                                [takerToken, makerToken],
                                ...intermediateTokens.map(t => [takerToken, t, makerToken]),
                            ].map(path => this.getUniswapV2BuyQuotes(uniLikeRouter, path, makerFillAmounts, source));
                        case ERC20BridgeSource.Kyber:
                            return getKyberOffsets().map(offset =>
                                this.getKyberBuyQuotes(
                                    KYBER_CONFIG_BY_CHAIN_ID[this.chainId],
                                    offset,
                                    makerToken,
                                    takerToken,
                                    makerFillAmounts,
                                ),
                            );
                        case ERC20BridgeSource.Curve:
                        case ERC20BridgeSource.Swerve:
                        case ERC20BridgeSource.SnowSwap:
                        case ERC20BridgeSource.Nerve:
                        case ERC20BridgeSource.Belt:
                        case ERC20BridgeSource.Ellipsis:
                            return getCurveLikeInfosForPair(this.chainId, takerToken, makerToken, source).map(pool =>
                                this.getCurveBuyQuotes(
                                    pool,
                                    pool.tokens.indexOf(takerToken),
                                    pool.tokens.indexOf(makerToken),
                                    makerFillAmounts,
                                    source,
                                ),
                            );
                        case ERC20BridgeSource.LiquidityProvider:
                            return getLiquidityProvidersForPair(
                                this.liquidityProviderRegistry,
                                takerToken,
                                makerToken,
                            ).map(pool =>
                                this.getLiquidityProviderBuyQuotes(pool, makerToken, takerToken, makerFillAmounts),
                            );
                        case ERC20BridgeSource.MStable:
                            return isValidAddress(MSTABLE_ROUTER_BY_CHAIN_ID[this.chainId])
                                ? this.getMStableBuyQuotes(
                                      MSTABLE_ROUTER_BY_CHAIN_ID[this.chainId],
                                      makerToken,
                                      takerToken,
                                      makerFillAmounts,
                                  )
                                : [];
                        case ERC20BridgeSource.Mooniswap:
                            return [
                                ...MOONISWAP_REGISTRIES_BY_CHAIN_ID[this.chainId]
                                    .filter(r => isValidAddress(r))
                                    .map(registry =>
                                        this.getMooniswapBuyQuotes(registry, makerToken, takerToken, makerFillAmounts),
                                    ),
                            ];
                        case ERC20BridgeSource.Balancer:
                            return this.balancerPoolsCache
                                .getCachedPoolAddressesForPair(takerToken, makerToken)!
                                .map(poolAddress =>
                                    this.getBalancerBuyQuotes(
                                        poolAddress,
                                        makerToken,
                                        takerToken,
                                        makerFillAmounts,
                                        ERC20BridgeSource.Balancer,
                                    ),
                                );
                        case ERC20BridgeSource.Cream:
                            return this.creamPoolsCache
                                .getCachedPoolAddressesForPair(takerToken, makerToken)!
                                .map(poolAddress =>
                                    this.getBalancerBuyQuotes(
                                        poolAddress,
                                        makerToken,
                                        takerToken,
                                        makerFillAmounts,
                                        ERC20BridgeSource.Cream,
                                    ),
                                );
                        case ERC20BridgeSource.Shell:
                            return getShellsForPair(this.chainId, takerToken, makerToken).map(pool =>
                                this.getShellBuyQuotes(pool, makerToken, takerToken, makerFillAmounts),
                            );
                        case ERC20BridgeSource.Dodo:
                            if (!isValidAddress(DODO_CONFIG_BY_CHAIN_ID[this.chainId].registry)) {
                                return [];
                            }
                            return this.getDODOBuyQuotes(
                                DODO_CONFIG_BY_CHAIN_ID[this.chainId],
                                makerToken,
                                takerToken,
                                makerFillAmounts,
                            );
                        case ERC20BridgeSource.DodoV2:
                            return _.flatten(
                                DODOV2_FACTORIES_BY_CHAIN_ID[this.chainId]
                                    .filter(factory => isValidAddress(factory))
                                    .map(factory =>
                                        getDodoV2Offsets().map(offset =>
                                            this.getDODOV2BuyQuotes(
                                                factory,
                                                offset,
                                                makerToken,
                                                takerToken,
                                                makerFillAmounts,
                                            ),
                                        ),
                                    ),
                            );
                        case ERC20BridgeSource.Bancor:
                            // Unimplemented
                            // return this.getBancorBuyQuotes(makerToken, takerToken, makerFillAmounts);
                            return [];
                        case ERC20BridgeSource.Linkswap:
                            if (!isValidAddress(LINKSWAP_ROUTER_BY_CHAIN_ID[this.chainId])) {
                                return [];
                            }
                            return [
                                [takerToken, makerToken],
                                // LINK is the base asset in many of the pools on Linkswap
                                ...getIntermediateTokens(makerToken, takerToken, {
                                    default: [TOKENS.LINK, TOKENS.WETH],
                                }).map(t => [takerToken, t, makerToken]),
                            ].map(path =>
                                this.getUniswapV2BuyQuotes(
                                    LINKSWAP_ROUTER_BY_CHAIN_ID[this.chainId],
                                    path,
                                    makerFillAmounts,
                                    ERC20BridgeSource.Linkswap,
                                ),
                            );
                        case ERC20BridgeSource.MakerPsm:
                            const psmInfo = MAKER_PSM_INFO_BY_CHAIN_ID[this.chainId];
                            if (!isValidAddress(psmInfo.psmAddress)) {
                                return [];
                            }
                            return this.getMakerPsmBuyQuotes(psmInfo, makerToken, takerToken, makerFillAmounts);
                        default:
                            throw new Error(`Unsupported buy sample source: ${source}`);
                    }
                },
            ),
        );
    }

    /**
     * Wraps `subOps` operations into a batch call to the sampler
     * @param subOps An array of Sampler operations
     * @param resultHandler The handler of the parsed batch results
     * @param revertHandler The handle for when the batch operation reverts. The result data is provided as an argument
     */
    private _createBatch<T, TResult>(
        subOps: Array<BatchedOperation<TResult>>,
        resultHandler: (results: TResult[]) => T,
        revertHandler: (result: string) => T,
    ): BatchedOperation<T> {
        return {
            encodeCall: () => {
                const subCalls = subOps.map(op => op.encodeCall());
                return this._samplerContract.batchCall(subCalls).getABIEncodedTransactionData();
            },
            handleCallResults: callResults => {
                const rawSubCallResults = this._samplerContract.getABIDecodedReturnData<SamplerCallResult[]>(
                    'batchCall',
                    callResults,
                );
                const results = subOps.map((op, i) =>
                    rawSubCallResults[i].success
                        ? op.handleCallResults(rawSubCallResults[i].data)
                        : op.handleRevert(rawSubCallResults[i].data),
                );
                return resultHandler(results);
            },
            handleRevert: revertHandler,
        };
    }
}
// tslint:disable max-file-line-count
