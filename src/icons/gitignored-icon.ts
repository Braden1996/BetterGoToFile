const GENERIC_FILE_ICON = `
  <path
    fill="#8A8A8A"
    d="M4 1.5A1.5 1.5 0 0 0 2.5 3v10A1.5 1.5 0 0 0 4 14.5h8a1.5 1.5 0 0 0 1.5-1.5V5.414a1.5 1.5 0 0 0-.44-1.06l-2.414-2.415A1.5 1.5 0 0 0 9.586 1.5H4Zm5.25 1.138c.14.033.27.105.378.213l2.52 2.52a.75.75 0 0 1 .214.379H9.75a.5.5 0 0 1-.5-.5V2.638Z"
  />
`;

const GITIGNORED_BADGE = `
  <circle cx="12" cy="12" r="3" fill="#6B7280" stroke="#FFFFFF" stroke-width="1"/>
  <path d="m10.75 13.25 2.5-2.5" stroke="#FFFFFF" stroke-linecap="round" stroke-width="1"/>
`;

export function createGitignoredIconDataUri(baseIconDataUri?: string): string {
  const baseLayer = baseIconDataUri
    ? `<image width="16" height="16" preserveAspectRatio="xMidYMid meet" href="${escapeXmlAttribute(baseIconDataUri)}"/>`
    : GENERIC_FILE_ICON;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="none" viewBox="0 0 16 16">${baseLayer}${GITIGNORED_BADGE}</svg>`;

  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

function escapeXmlAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}
