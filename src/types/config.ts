import type { RpcProvider, SupportedChain } from "./chains.js";
import type {
  PairedSolanaEntry,
  PairedTronEntry,
  PairedBitcoinEntry,
  PairedBitcoinMultisigWallet,
  PairedLitecoinEntry,
} from "./devices.js";

export interface UserConfig {
  rpc: {
    provider: RpcProvider;
    /** API key for infura/alchemy. Ignored when provider === "custom". */
    apiKey?: string;
    /** Only used when provider === "custom". */
    customUrls?: Partial<Record<SupportedChain, string>>;
  };
  etherscanApiKey?: string;
  /** Optional 1inch Developer Portal API key for intra-chain swap-quote comparison. */
  oneInchApiKey?: string;
  /**
   * Optional Reservoir API key for the NFT-portfolio tools (`get_nft_*`).
   * Reservoir's free tier serves anonymous requests but rate-limits at
   * a tight ceiling that doesn't survive multi-chain portfolio fan-out;
   * configuring a key avoids 429s. Free key at https://reservoir.tools/.
   * Env var `RESERVOIR_API_KEY` takes priority over this field.
   */
  reservoirApiKey?: string;
  /**
   * Safe Transaction Service API key. Required to call `get_safe_positions` and
   * the v2/v3 propose/execute Safe tools — modern `*.safe.global` endpoints
   * authenticate every request. Get one at https://developer.safe.global/.
   * Env var `SAFE_API_KEY` takes priority over this field.
   */
  safeApiKey?: string;
  /**
   * TronGrid API key (`TRON-PRO-API-KEY` header). Required to read TRX and
   * TRC-20 balances on the `tron` chain — TronGrid rate-limits unauthenticated
   * calls to ~15 req/min, which is too tight for portfolio fan-out.
   */
  tronApiKey?: string;
  /**
   * Solana mainnet RPC URL. Paste the full URL from your provider (Helius,
   * QuickNode, Alchemy Solana, Triton, etc.) — most include the API key in
   * the URL (e.g. `https://mainnet.helius-rpc.com/?api-key=KEY`). The public
   * mainnet endpoint is rate-limited and unreliable for production use;
   * configuring a provider is strongly recommended. Env var `SOLANA_RPC_URL`
   * takes priority over this field.
   */
  solanaRpcUrl?: string;
  /**
   * Bitcoin indexer base URL (Esplora-compatible REST API). Defaults to
   * mempool.space's free public API; override here when running against a
   * self-hosted Esplora / Electrs / Mempool.space instance, or any
   * privacy-preserving relay. Env var `BITCOIN_INDEXER_URL` takes priority
   * over this field.
   */
  bitcoinIndexerUrl?: string;
  /**
   * Litecoin indexer base URL (Esplora-compatible REST API). Defaults
   * to litecoinspace.org's free public API; override here when running
   * against a self-hosted Esplora / Electrs instance. Env var
   * `LITECOIN_INDEXER_URL` takes priority over this field.
   */
  litecoinIndexerUrl?: string;
  walletConnect?: {
    projectId?: string;
    /** Topic of the active WC session (so we can resume after restart). */
    sessionTopic?: string;
    pairingTopic?: string;
  };
  /**
   * Cached Ledger pairings, persisted across server restarts. Public fields
   * only (addresses, BIP-44 paths, app versions) — no private keys, no
   * secrets. The signing path always re-derives from the live device and
   * verifies the address before signing, so a planted/stale entry can at
   * worst surface a wrong address in `get_ledger_status` (which the user
   * notices when their balances don't match).
   */
  pairings?: {
    solana?: PairedSolanaEntry[];
    tron?: PairedTronEntry[];
    /**
     * Bitcoin pairings — typically four entries per accountIndex, one
     * per address type (legacy / p2sh-segwit / segwit / taproot). Same
     * write-through-to-disk semantics as the Solana / TRON slices.
     */
    bitcoin?: PairedBitcoinEntry[];
    /**
     * Registered Bitcoin multi-sig wallet policies. One entry per
     * registered wallet; each carries the descriptor + cosigner xpubs +
     * Ledger policy HMAC needed to sign subsequent PSBTs without
     * re-walking the on-device descriptor approval flow.
     */
    bitcoinMultisig?: PairedBitcoinMultisigWallet[];
    /**
     * Litecoin pairings — same shape as the Bitcoin slice, BIP-44
     * coin_type 2 instead of 0.
     */
    litecoin?: PairedLitecoinEntry[];
  };
}
