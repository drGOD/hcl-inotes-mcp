/** In-memory cookie jar for one Domino / iNotes session. Values never go to disk. */
export class CookieJar {
  private readonly cookies = new Map<string, string>();

  loadHeader(header: string): void {
    const cleaned = header.replace(/^cookie\s*:\s*/i, "").trim();
    if (!cleaned) return;
    for (const part of cleaned.split(";")) {
      const eq = part.indexOf("=");
      if (eq <= 0) continue;
      const name = part.slice(0, eq).trim();
      const value = part.slice(eq + 1).trim();
      if (name && value) this.cookies.set(name, value);
    }
  }

  absorb(headers: Headers): void {
    const fromFetch = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [];
    const lines = fromFetch.length > 0 ? fromFetch : compact(headers.get("set-cookie"));
    for (const line of lines) {
      const semi = line.indexOf(";");
      const pair = (semi === -1 ? line : line.slice(0, semi)).trim();
      const eq = pair.indexOf("=");
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (!name) continue;
      if (!value) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  header(): string {
    return [...this.cookies.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  hasSession(): boolean {
    for (const name of this.cookies.keys()) {
      if (/^DomAuthSessId/i.test(name) || /^LtpaToken/i.test(name)) return true;
    }
    return false;
  }

  /**
   * iNotes POST requests since 8.5.2 require %%Nonce.
   * The public client stores it as the N: parameter of the ShimmerS cookie.
   */
  nonce(): string | undefined {
    const raw = this.cookies.get("ShimmerS");
    if (!raw) return undefined;
    let decoded = raw;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      decoded = raw;
    }
    const match = decoded.match(/(?:^|&)N:([^&]+)/);
    return match?.[1];
  }
}

function compact(value: string | null): string[] {
  return value ? [value] : [];
}
