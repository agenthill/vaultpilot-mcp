import type { SupportedChain } from "./chains.js";

export interface PrivilegedRole {
  role: string;
  holder: `0x${string}`;
  isContract: boolean;
  isMultisig: boolean;
  hasTimelock: boolean;
  timelockDelaySeconds?: number;
}

export interface SecurityReport {
  address: `0x${string}`;
  chain: SupportedChain;
  isVerified: boolean;
  isProxy: boolean;
  implementation?: `0x${string}`;
  admin?: `0x${string}`;
  dangerousFunctions: string[];
  privilegedRoles: PrivilegedRole[];
}
