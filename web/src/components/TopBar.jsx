import { Link } from 'react-router-dom';
import Logo from './Logo.jsx';

export default function TopBar({ title }) {
  return (
    <header className="flex items-center gap-3 mb-4 min-w-0">
      <Link to="/" className="flex flex-none items-center gap-2 text-fg1 font-bold text-[15px] no-underline hover:text-blurple">
        <Logo />
        telinha
      </Link>
      <span className="w-px h-4 bg-line flex-none" aria-hidden="true" />
      <h1 className="text-fg1 font-semibold text-lg truncate min-w-0 m-0">{title}</h1>
    </header>
  );
}
