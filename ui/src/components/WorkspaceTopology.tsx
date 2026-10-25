/** Exact vector geometry from Stitch UI-01, kept inline for local font rendering. */
export function WorkspaceTopology() {
  return <div className="topology-chart"><svg width="100%" height="128" fill="none" viewBox="0 0 320 120" role="img" aria-label="本机宿主连接独立工作区与 Agent 的拓扑示意">
    <path d="M0 30H320M0 60H320M0 90H320" stroke="#efeeea" strokeDasharray="2 4" strokeWidth="1"/>
    <path d="M60 60C110 60 130 35 170 35M60 60C110 60 130 85 170 85M170 35C210 35 230 45 260 45M170 85C210 85 230 75 260 75" stroke="#dbc1b9" strokeWidth="1.5"/>
    <circle fill="#ffdbd0" cx="60" cy="60" r="14"/>
    <circle fill="#974324" cx="60" cy="60" r="6"/>
    <text fill="#1b1c1a" style={{fontFamily:'var(--font-code)',fontSize:9}} textAnchor="middle" x="60" y="90">RIFT (Host)</text>
    <circle fill="#e3e2df" cx="170" cy="35" r="10"/>
    <circle fill="#625e57" cx="170" cy="35" r="4"/>
    <circle fill="#e3e2df" cx="170" cy="85" r="10"/>
    <circle fill="#625e57" cx="170" cy="85" r="4"/>
    <circle fill="#e3e2df" cx="260" cy="45" r="8"/>
    <circle fill="#e3e2df" cx="260" cy="75" r="8"/>
  </svg></div>;
}
