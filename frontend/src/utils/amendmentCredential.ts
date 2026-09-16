import { ContractParty } from '../types/enums';
import { IssuedCredential } from '../types/amendment';

/**
 * 一次性确认凭据。
 *
 * 明文形如 `amd-a_0f3a…`（甲方）/ `amd-b_9c21…`（乙方），前缀仅用于让
 * 持票人知道自己该对号到哪一侧；真正的校验依据是数据库中保存的
 * SHA-256 哈希，因此泄露库文件也无法还原出可使用的明文票。
 */

const PARTY_PREFIX: Record<ContractParty, string> = {
  [ContractParty.PartyA]: 'amd-a_',
  [ContractParty.PartyB]: 'amd-b_'
};

const TOKEN_PATTERN = /^amd-(a|b)_([0-9a-f]{32})$/;

export function issueCredentialPair(): IssuedCredential[] {
  return [
    { party: ContractParty.PartyA, token: `${PARTY_PREFIX[ContractParty.PartyA]}${randomSecret()}` },
    { party: ContractParty.PartyB, token: `${PARTY_PREFIX[ContractParty.PartyB]}${randomSecret()}` }
  ];
}

/** 解析凭据前缀得到当事方；格式非法返回 null（不抛异常，由调用方按错票处理） */
export function parseCredentialParty(token: string): ContractParty | null {
  const match = TOKEN_PATTERN.exec(token.trim());
  if (!match) {
    return null;
  }
  return match[1] === 'a' ? ContractParty.PartyA : ContractParty.PartyB;
}

/** 计算凭据明文的 SHA-256（hex） */
export async function hashCredential(token: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token.trim()));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** 常量时间比较，避免哈希比对的计时侧信道 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/** 生成 16 字节随机秘密（32 位 hex） */
function randomSecret(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
