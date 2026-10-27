import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { safeStorage } from "electron";

// Keeps the sign-in token encrypted with the OS keychain (Keychain on macOS,
// DPAPI on Windows). Where encryption is unavailable the user just signs in
// again each launch rather than having the token stored in plain text.
export class TokenStore {
  private token: string | null = null;
  private readonly file: string;

  constructor(userDataDir: string) {
    this.file = join(userDataDir, "session.bin");
    if (existsSync(this.file) && safeStorage.isEncryptionAvailable()) {
      try {
        this.token = safeStorage.decryptString(readFileSync(this.file));
      } catch {
        rmSync(this.file, { force: true });
      }
    }
  }

  get(): string | null {
    return this.token;
  }

  set(token: string | null) {
    this.token = token;
    if (token && safeStorage.isEncryptionAvailable()) writeFileSync(this.file, safeStorage.encryptString(token));
    else rmSync(this.file, { force: true });
  }
}
