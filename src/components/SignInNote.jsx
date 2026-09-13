import { useSession, connectWallet, signIn, stepOf } from "../services/wallet.service";
import { useUsernames, isGated } from "../services/usernames.service";

/**
 * One line under a page header when usernames are behind sign-in on this
 * host and the reader has not signed in: nothing otherwise. Signed in is
 * the whole condition (never the wall). Not connected: the click
 * connects, which asks for the one signature too. Connected but the
 * wallet would not sign outside a click: this click asks again.
 */
export function SignInNote() {
  const s = useSession();
  useUsernames();
  if (s.status === "signed" || s.status === "unavailable" || !isGated()) return null;
  const step = stepOf(s);
  return (
    <p className="text-muted signin-note-line">
      Usernames show after you{" "}
      <button type="button" className="link-btn" onClick={() => void (step === "connected" ? signIn() : connectWallet())} disabled={step === "busy"}>
        sign in with your wallet
      </button>.
      {s.error && <span className="signin-note-error" role="alert"> {s.error}</span>}
    </p>
  );
}
