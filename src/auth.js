import { randomBytes } from "node:crypto";

// Only the DSH client RPC issues invitations. Public HTTP pages never mint or
// embed credentials; Origin/Fetch Metadata checks are supplementary, not trust.
export class LocalApproval {
  constructor({ now = () => Date.now() } = {}) {
    this.now = now;
    this.invitations = new Map();
    this.sessions = new Map();
  }
  prune() {
    for (const entries of [this.invitations, this.sessions]) {
      for (const [key, entry] of entries) if (entry.expires <= this.now()) entries.delete(key);
    }
  }
  invite(scope) {
    this.prune();
    const secret = randomBytes(32).toString("hex");
    this.invitations.set(secret, { scope, expires: this.now() + 60000 });
    if (this.invitations.size > 32) this.invitations.delete(this.invitations.keys().next().value);
    return secret;
  }
  exchange(secret, scope) {
    this.prune();
    const invitation = this.invitations.get(secret);
    if (!invitation || invitation.scope !== scope) return undefined;
    this.invitations.delete(secret);
    const key = randomBytes(32).toString("hex");
    this.sessions.set(key, { scope, expires: this.now() + 30 * 60000 });
    if (this.sessions.size > 128) this.sessions.delete(this.sessions.keys().next().value);
    return key;
  }
  permits(key, scope) {
    this.prune();
    return typeof key === "string" && this.sessions.get(key)?.scope === scope;
  }
  close() { this.invitations.clear(); this.sessions.clear(); }
}

export function approvalScript(scope) {
  return `const approvalReady=(async()=>{const store=${JSON.stringify(`dsh-approval-${scope}`)};const secret=new URLSearchParams(location.hash.slice(1)).get('approve');if(secret){history.replaceState(null,'',location.pathname);const response=await fetch('/auth/session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({secret,scope:${JSON.stringify(scope)}})});if(!response.ok)throw Error('打开链接已过期，请从 DSH 菜单重新打开');const value=await response.json();sessionStorage.setItem(store,value.key)}const key=sessionStorage.getItem(store);if(!key)throw Error('请从 DSH 的 ${scope === "setup" ? "/browser 浏览器连接" : "/apps 应用管理"}菜单打开，以确认本次操作');return key})();`;
}
