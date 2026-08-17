export default function Facepile({ viewers, max = 6 }) {
  if (!viewers.length) {
    return (
      <span className="flex items-center gap-2 text-fg4 text-[13px]">
        <span className="w-8 h-8 rounded-full border-2 border-dashed border-line flex items-center justify-center" aria-hidden="true">
          👀
        </span>
        ninguém ainda
      </span>
    );
  }

  const shown = viewers.slice(0, max);
  const overflow = viewers.length - shown.length;

  return (
    <span className="flex items-center gap-2.5">
      <span className="flex items-center">
        {shown.map((v, i) => (
          <span
            key={v.id}
            title={v.name}
            className="relative w-8 h-8 rounded-full ring-2 ring-bg0 flex items-center justify-center text-base -ml-2 first:ml-0"
            style={{ background: v.color, zIndex: shown.length - i }}
          >
            {v.emoji}
          </span>
        ))}
        {overflow > 0 && (
          <span className="relative w-8 h-8 -ml-2 rounded-full ring-2 ring-bg0 bg-bg3 text-fg3 text-[11px] font-bold flex items-center justify-center">
            +{overflow}
          </span>
        )}
      </span>
      <span className="text-fg3 text-[13px] whitespace-nowrap">{viewers.length} assistindo</span>
    </span>
  );
}
