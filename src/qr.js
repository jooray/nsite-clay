// A QR code, drawn here rather than fetched.
//
// The obvious way to show a nostrconnect:// code is an <img> pointing at a QR
// service. That hands the URI to a third party, and a nostrconnect URI contains
// the client public key and the one-time connection secret: whoever renders the
// image can answer the connection. So the code is generated in the page, as an
// SVG, and nothing leaves the browser.
import qrcode from "qrcode-generator";

// Error correction M survives a phone camera at an angle without inflating the
// code the way H would. Type 0 lets the library pick the smallest that fits.
export function qrSvg(text, { size = 220, margin = 2, dark = "#000", light = "#fff" } = {}) {
  const qr = qrcode(0, "M");
  qr.addData(String(text));
  qr.make();
  const count = qr.getModuleCount();
  const span = count + margin * 2;

  // One path for every dark module beats one <rect> each: a 41x41 code is 1681
  // elements otherwise, and Safari renders hairline seams between them.
  let d = "";
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) d += `M${col + margin} ${row + margin}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 ${span} ${span}" shape-rendering="crispEdges" role="img" ` +
    `aria-label="Sign-in code"><rect width="${span}" height="${span}" fill="${light}"/>` +
    `<path d="${d}" fill="${dark}"/></svg>`;
}

// The same thing as an element, ready to append.
export function qrElement(text, opts = {}, doc = document) {
  const wrap = doc.createElement("div");
  wrap.innerHTML = qrSvg(text, opts);
  const svg = wrap.firstElementChild;
  svg.style.cssText = `display:block;margin:.8rem auto;border-radius:8px;max-width:100%;height:auto`;
  return svg;
}
