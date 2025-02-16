import { ChainId } from '@0x/contract-addresses';
import { BigNumber, NULL_BYTES } from '@0x/utils';

import {
    BAKERYSWAP_ROUTER_BY_CHAIN_ID,
    BELT_BSC_INFOS,
    CRYPTO_COM_ROUTER_BY_CHAIN_ID,
    ELLIPSIS_BSC_INFOS,
    KYBER_BRIDGED_LIQUIDITY_PREFIX,
    KYBER_DMM_ROUTER_BY_CHAIN_ID,
    MAINNET_CURVE_INFOS,
    MAINNET_SNOWSWAP_INFOS,
    MAINNET_SWERVE_INFOS,
    MAX_DODOV2_POOLS_QUERIED,
    MAX_KYBER_RESERVES_QUERIED,
    NERVE_BSC_INFOS,
    NULL_ADDRESS,
    PANCAKESWAP_ROUTER_BY_CHAIN_ID,
    SHELL_POOLS_BY_CHAIN_ID,
    SUSHISWAP_ROUTER_BY_CHAIN_ID,
    UNISWAPV2_ROUTER_BY_CHAIN_ID,
} from './constants';
import { CurveInfo, ERC20BridgeSource } from './types';

/**
 * Filter Kyber reserves which should not be used (0xbb bridged reserves)
 * @param reserveId Kyber reserveId
 */
export function isAllowedKyberReserveId(reserveId: string): boolean {
    return reserveId !== NULL_BYTES && !reserveId.startsWith(KYBER_BRIDGED_LIQUIDITY_PREFIX);
}

// tslint:disable-next-line: completed-docs ban-types
export function isValidAddress(address: string | String): address is string {
    return (typeof address === 'string' || address instanceof String) && address.toString() !== NULL_ADDRESS;
}

/**
 * Returns the offsets to be used to discover Kyber reserves
 */
export function getKyberOffsets(): BigNumber[] {
    return Array(MAX_KYBER_RESERVES_QUERIED)
        .fill(0)
        .map((_v, i) => new BigNumber(i));
}

// tslint:disable completed-docs
export function getDodoV2Offsets(): BigNumber[] {
    return Array(MAX_DODOV2_POOLS_QUERIED)
        .fill(0)
        .map((_v, i) => new BigNumber(i));
}

// tslint:disable completed-docs
export function getShellsForPair(chainId: ChainId, takerToken: string, makerToken: string): string[] {
    if (chainId !== ChainId.Mainnet) {
        return [];
    }
    return Object.values(SHELL_POOLS_BY_CHAIN_ID[chainId])
        .filter(c => [makerToken, takerToken].every(t => c.tokens.includes(t)))
        .map(i => i.poolAddress);
}

// tslint:disable completed-docs
export function getCurveInfosForPair(chainId: ChainId, takerToken: string, makerToken: string): CurveInfo[] {
    if (chainId !== ChainId.Mainnet) {
        return [];
    }
    return Object.values(MAINNET_CURVE_INFOS).filter(c =>
        [makerToken, takerToken].every(
            t =>
                (c.tokens.includes(t) && c.metaToken === undefined) ||
                (c.tokens.includes(t) && c.metaToken !== undefined && [makerToken, takerToken].includes(c.metaToken)),
        ),
    );
}

export function getSwerveInfosForPair(chainId: ChainId, takerToken: string, makerToken: string): CurveInfo[] {
    if (chainId !== ChainId.Mainnet) {
        return [];
    }
    return Object.values(MAINNET_SWERVE_INFOS).filter(c =>
        [makerToken, takerToken].every(
            t =>
                (c.tokens.includes(t) && c.metaToken === undefined) ||
                (c.tokens.includes(t) && c.metaToken !== undefined && [makerToken, takerToken].includes(c.metaToken)),
        ),
    );
}

export function getSnowSwapInfosForPair(chainId: ChainId, takerToken: string, makerToken: string): CurveInfo[] {
    if (chainId !== ChainId.Mainnet) {
        return [];
    }
    return Object.values(MAINNET_SNOWSWAP_INFOS).filter(c =>
        [makerToken, takerToken].every(
            t =>
                (c.tokens.includes(t) && c.metaToken === undefined) ||
                (c.tokens.includes(t) && c.metaToken !== undefined && [makerToken, takerToken].includes(c.metaToken)),
        ),
    );
}

export function getNerveInfosForPair(chainId: ChainId, takerToken: string, makerToken: string): CurveInfo[] {
    if (chainId !== ChainId.BSC) {
        return [];
    }
    return Object.values(NERVE_BSC_INFOS).filter(c =>
        [makerToken, takerToken].every(
            t =>
                (c.tokens.includes(t) && c.metaToken === undefined) ||
                (c.tokens.includes(t) && c.metaToken !== undefined && [makerToken, takerToken].includes(c.metaToken)),
        ),
    );
}

export function getBeltInfosForPair(chainId: ChainId, takerToken: string, makerToken: string): CurveInfo[] {
    if (chainId !== ChainId.BSC) {
        return [];
    }
    return Object.values(BELT_BSC_INFOS).filter(c =>
        [makerToken, takerToken].every(
            t =>
                (c.tokens.includes(t) && c.metaToken === undefined) ||
                (c.tokens.includes(t) && c.metaToken !== undefined && [makerToken, takerToken].includes(c.metaToken)),
        ),
    );
}

export function getEllipsisInfosForPair(chainId: ChainId, takerToken: string, makerToken: string): CurveInfo[] {
    if (chainId !== ChainId.BSC) {
        return [];
    }
    return Object.values(ELLIPSIS_BSC_INFOS).filter(c =>
        [makerToken, takerToken].every(
            t =>
                (c.tokens.includes(t) && c.metaToken === undefined) ||
                (c.tokens.includes(t) && c.metaToken !== undefined && [makerToken, takerToken].includes(c.metaToken)),
        ),
    );
}

export function getCurveLikeInfosForPair(
    chainId: ChainId,
    takerToken: string,
    makerToken: string,
    source:
        | ERC20BridgeSource.Curve
        | ERC20BridgeSource.Swerve
        | ERC20BridgeSource.SnowSwap
        | ERC20BridgeSource.Nerve
        | ERC20BridgeSource.Belt
        | ERC20BridgeSource.Ellipsis,
): CurveInfo[] {
    switch (source) {
        case ERC20BridgeSource.Curve:
            return getCurveInfosForPair(chainId, takerToken, makerToken);
        case ERC20BridgeSource.Swerve:
            return getSwerveInfosForPair(chainId, takerToken, makerToken);
        case ERC20BridgeSource.SnowSwap:
            return getSnowSwapInfosForPair(chainId, takerToken, makerToken);
        case ERC20BridgeSource.Nerve:
            return getNerveInfosForPair(chainId, takerToken, makerToken);
        case ERC20BridgeSource.Belt:
            return getBeltInfosForPair(chainId, takerToken, makerToken);
        case ERC20BridgeSource.Ellipsis:
            return getEllipsisInfosForPair(chainId, takerToken, makerToken);
        default:
            throw new Error(`Unknown Curve like source ${source}`);
    }
}

export function uniswapV2LikeRouterAddress(
    chainId: ChainId,
    source:
        | ERC20BridgeSource.UniswapV2
        | ERC20BridgeSource.SushiSwap
        | ERC20BridgeSource.CryptoCom
        | ERC20BridgeSource.PancakeSwap
        | ERC20BridgeSource.BakerySwap
        | ERC20BridgeSource.KyberDmm,
): string {
    switch (source) {
        case ERC20BridgeSource.UniswapV2:
            return UNISWAPV2_ROUTER_BY_CHAIN_ID[chainId];
        case ERC20BridgeSource.SushiSwap:
            return SUSHISWAP_ROUTER_BY_CHAIN_ID[chainId];
        case ERC20BridgeSource.CryptoCom:
            return CRYPTO_COM_ROUTER_BY_CHAIN_ID[chainId];
        case ERC20BridgeSource.PancakeSwap:
            return PANCAKESWAP_ROUTER_BY_CHAIN_ID[chainId];
        case ERC20BridgeSource.BakerySwap:
            return BAKERYSWAP_ROUTER_BY_CHAIN_ID[chainId];
        case ERC20BridgeSource.KyberDmm:
            return KYBER_DMM_ROUTER_BY_CHAIN_ID[chainId];
        default:
            throw new Error(`Unknown UniswapV2 like source ${source}`);
    }
}

const BAD_TOKENS_BY_SOURCE: Partial<{ [key in ERC20BridgeSource]: string[] }> = {
    [ERC20BridgeSource.Uniswap]: [
        '0xb8c77482e45f1f44de1745f52c74426c631bdd52', // BNB
    ],
};

export function isBadTokenForSource(token: string, source: ERC20BridgeSource): boolean {
    return (BAD_TOKENS_BY_SOURCE[source] || []).includes(token.toLowerCase());
}
