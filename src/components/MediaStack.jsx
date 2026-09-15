import { CORE_MEDIA_FIELDS, getMediaTypeLabel, sortMediaTypes } from "../services/ipfs.analysis";
import { describeMedia, mediaCellLines } from "../services/ipfs.media";

/**
 * An edition's media files, one line each, the shape the set page table
 * uses: "MP4 · 1080x1920 · 13.2 MB · 23s (Video)". Core files first: a
 * present file is a link, a missing one a red X placeholder, a CID dead
 * at the gateway a warning. Extras follow in a quieter colour; dead
 * extras fold onto one warning line. Shared by the set page rows and the
 * edition page.
 *
 * onOpen(url, "video" | "image", mediaType)  a click on a live file
 * activeUrl     the file lit as active (the edition page's playing video)
 * playerExtra   rides beside the Player line (the dynamic photo button)
 * extraLines    appended after the files (the edition page's commentary)
 * grouped       headings over each group, as the set page's coverage
 *               panel names them: IPFS Core, IPFS Extras, and offChainTitle
 *               over the extraLines (files not registered on chain)
 */
export function MediaStack({ cids, ipfsMedia, onOpen, activeUrl, playerExtra, extraLines, grouped = false, offChainTitle = "Off-chain media" }) {
  const isLive = (cid) => cid && !(ipfsMedia && ipfsMedia.media[cid] === 0);
  const line = (mediaType, cid) => {
    const label = getMediaTypeLabel(mediaType).replace(/^\S+\s/, "");
    if (!cid) {
      return (
        <span key={mediaType} className="ipfs-line" title={`${label}: missing from the IPFS resolver`}>
          <span style={{ fontSize: "0.68rem" }}>❌</span> <span className="ipfs-line-label">{label}</span>
        </span>
      );
    }
    if (ipfsMedia && ipfsMedia.media[cid] === 0) {
      return (
        <span key={mediaType} className="ipfs-line" title={describeMedia(cid)} style={{ cursor: "help" }}>
          ⚠️ <span className="ipfs-line-label">{label}</span>
        </span>
      );
    }
    const url = `https://ipfs.dapperlabs.com/ipfs/${cid}`;
    const isVideo = mediaType.toLowerCase().startsWith("video");
    // Pre-click context from the probe lookup: dimensions, duration, size,
    // audio, and when the gateway last confirmed the file; the hash tail
    // until the lookup loads
    const desc = ipfsMedia ? describeMedia(cid) : null;
    const lines = ipfsMedia ? mediaCellLines(cid) : null;
    const info = lines
      ? `${lines.top}${lines.bottom ? ` · ${lines.bottom}` : ""}`
      : `...${cid.substring(cid.length - 6)}`;
    return (
      <a
        key={mediaType}
        className={`ipfs-line${activeUrl && activeUrl === url ? " is-active" : ""}`}
        href={url}
        onClick={(e) => {
          e.preventDefault();
          if (onOpen) onOpen(url, isVideo ? "video" : "image", mediaType);
        }}
        title={`${desc ? `${desc}\n` : ""}Click to ${isVideo ? "play video" : "view image"}. CID: ${cid}`}
      >
        {info} <span className="ipfs-line-label">({label})</span>
      </a>
    );
  };

  const all = cids || {};
  const extras = sortMediaTypes(Object.keys(all)).filter((t) => !CORE_MEDIA_FIELDS.includes(t) && all[t]);
  const liveExtras = extras.filter((t) => isLive(all[t]));
  const deadExtraNames = extras
    .filter((t) => !isLive(all[t]))
    .map((t) => getMediaTypeLabel(t).replace(/^\S+\s/, ""))
    .join(", ");
  const hasExtraLines = Boolean(extraLines && extraLines.length > 0);
  const extrasBlock = (
    <>
      {liveExtras.map((t) => line(t, all[t]))}
      {deadExtraNames && (
        <span className="ipfs-line" title={`${deadExtraNames}: registered on chain, but the IPFS gateway serves no content`} style={{ cursor: "help" }}>
          ⚠️ <span className="ipfs-line-label">{deadExtraNames}</span>
        </span>
      )}
    </>
  );
  return (
    <div className="ipfs-stack">
      {grouped && <div className="ipfs-stack-head">IPFS Core</div>}
      {CORE_MEDIA_FIELDS.map((f) => (f === "PLAYER" && playerExtra ? (
        <span key={f} className="ipfs-line-row">
          {line(f, all[f])}
          {playerExtra}
        </span>
      ) : line(f, all[f])))}
      {grouped ? (
        <>
          {extras.length > 0 && (
            <>
              <div className="ipfs-stack-head">IPFS Extras</div>
              <div className="ipfs-stack ipfs-stack-extras" style={{ marginTop: 0 }}>{extrasBlock}</div>
            </>
          )}
          {hasExtraLines && (
            <>
              <div className="ipfs-stack-head">{offChainTitle}</div>
              <div className="ipfs-stack ipfs-stack-extras" style={{ marginTop: 0 }}>{extraLines}</div>
            </>
          )}
        </>
      ) : (extras.length > 0 || hasExtraLines) && (
        <div className="ipfs-stack ipfs-stack-extras">
          {extrasBlock}
          {extraLines}
        </div>
      )}
    </div>
  );
}
