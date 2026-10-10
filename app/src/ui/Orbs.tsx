export function ArbLogo({ className = '' }: { className?: string }) {
  return (
    <svg 
      className={className} 
      viewBox="0 0 28 28" 
      fill="none" 
      xmlns="http://www.w3.org/2000/svg"
      style={{ width: 28, height: 28 }}
    >
      <circle cx="14" cy="14" r="12" stroke="currentColor" strokeWidth="1.8" strokeDasharray="3 2" />
      <path 
        d="M8 14H20M14 8L20 14L14 20" 
        stroke="currentColor" 
        strokeWidth="2" 
        strokeLinecap="round" 
        strokeLinejoin="round" 
      />
    </svg>
  );
}

export function Orbs({ fixed = false }: { fixed?: boolean }) {
  return (
    <div className={fixed ? "uni-orbs fixed" : "uni-orbs"} aria-hidden="true">
      <span className="uni-orb-glow-1" />
      <span className="uni-orb-glow-2" />
      <span className="uni-orb-glow-3" />
    </div>
  );
}
