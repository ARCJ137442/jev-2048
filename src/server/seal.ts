/**
 * 密钥封存。
 *
 * ⚠ 先把话说清楚：**这不是密码学意义上的保护。**
 *
 * 口令的默认值就写在源码里，任何拿到本仓库的人都能解开。
 * 它挡不住有心人，也不需要挡住 —— 真正的密钥保护靠的是「不下发到客户端」
 * 与「服务端环境变量」，那是架构层面的事。
 *
 * 这个模块解决的是另一类问题：**密钥以明文形式躺在磁盘上**。
 * 明文文件会在这些场景里意外外泄：
 *   - 被 `cat` / grep 扫到，出现在终端回滚或截图里
 *   - 被误提交进 git（.gitignore 挡得住常规路径，挡不住 `git add -f`）
 *   - 混进备份、日志、错误上报
 *
 * 封存后，磁盘上只有一段无法肉眼辨认的密文；解封需要显式调用。
 * 这是**降低意外暴露面**，不是防御性安全措施。
 *
 * 想更严一点：把口令放进 `JEV_SEAL_PASSPHRASE` 环境变量，源码里就只留默认值。
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/** 封存文件的格式标记，用于识别与版本判定 */
const MAGIC = "JEVSEAL1";
const SALT_LEN = 16;
const IV_LEN = 12;
const KEY_LEN = 32;

/** 默认口令。可用 JEV_SEAL_PASSPHRASE 覆盖。 */
const DEFAULT_PASSPHRASE = "jev2048-local-seal-v1";

function passphrase(): string {
  const env = process.env.JEV_SEAL_PASSPHRASE;
  return env && env.length > 0 ? env : DEFAULT_PASSPHRASE;
}

/** 口令 + 盐 → 32 字节密钥 */
function deriveKey(salt: Buffer): Buffer {
  return scryptSync(passphrase(), salt, KEY_LEN);
}

/**
 * 把明文封存成一行 base64。
 * 格式：MAGIC | salt | iv | tag | ciphertext
 */
export function seal(plaintext: string): string {
  const salt = randomBytes(SALT_LEN);
  const iv = randomBytes(IV_LEN);
  const key = deriveKey(salt);

  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return Buffer.concat([
    Buffer.from(MAGIC, "ascii"),
    salt,
    iv,
    tag,
    body,
  ]).toString("base64");
}

/** 文本是否看起来像封存过的内容 */
export function isSealed(text: string): boolean {
  try {
    const buf = Buffer.from(text.trim(), "base64");
    return buf.length > MAGIC.length && buf.subarray(0, MAGIC.length).toString("ascii") === MAGIC;
  } catch {
    return false;
  }
}

/**
 * 解封。失败返回 null —— 调用方据此回落到其他密钥来源，
 * 不要把异常抛到启动路径上（那会让整个服务起不来）。
 */
export function unseal(sealed: string): string | null {
  try {
    const buf = Buffer.from(sealed.trim(), "base64");
    if (buf.subarray(0, MAGIC.length).toString("ascii") !== MAGIC) return null;

    let at = MAGIC.length;
    const salt = buf.subarray(at, (at += SALT_LEN));
    const iv = buf.subarray(at, (at += IV_LEN));
    const tag = buf.subarray(at, (at += 16));
    const body = buf.subarray(at);

    const decipher = createDecipheriv("aes-256-gcm", deriveKey(salt), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(body), decipher.final()]).toString("utf8");
  } catch {
    // 口令不对、内容被改、格式损坏 —— 一律视作解不开
    return null;
  }
}
