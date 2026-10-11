import logoUrl from '../assets/logo.png';

export function ArbLogo({ className = '', style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <img 
      src={logoUrl} 
      alt="ArbSwap Logo" 
      className={className} 
      style={{ 
        width: 28, 
        height: 28, 
        objectFit: 'contain',
        display: 'inline-block',
        verticalAlign: 'middle',
        filter: 'drop-shadow(0 0 6px rgba(0, 229, 176, 0.35))',
        ...style 
      }} 
    />
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
