import { useId } from 'react';

export default function Logo({ size = 20 }) {
  const id = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop stopColor="#5865F2" />
          <stop offset="1" stopColor="#4752C4" />
        </linearGradient>
      </defs>
      <rect x="2" y="3.5" width="20" height="14" rx="4" fill={`url(#${id})`} />
      <path d="M10 8.25v4.5l4.25-2.25L10 8.25z" fill="#fff" />
      <rect x="8" y="19.5" width="8" height="2" rx="1" fill="#3f4147" />
    </svg>
  );
}
