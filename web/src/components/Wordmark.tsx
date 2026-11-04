import Link from "next/link";

/**
 * "scribble" in crayon lettering with a tomato squiggle that draws itself once.
 * `size="small"` is the compact version used in page headers.
 */
export function Wordmark({ size = "large" }: { size?: "large" | "small" }) {
  const large = size === "large";
  const word = (
    <span className="relative inline-block">
      <span
        className={
          large
            ? "font-hand block text-[clamp(4.75rem,13vw,8.5rem)] leading-[0.8] text-cobalt"
            : "font-hand block text-4xl leading-none text-cobalt"
        }
      >
        scribble
      </span>
      <svg
        aria-hidden="true"
        viewBox="0 0 300 24"
        preserveAspectRatio="none"
        className={large ? "mt-1 block h-5 w-[92%]" : "block h-2.5 w-[92%]"}
      >
        <path
          // Draws itself once on the landing page; the small header version is static.
          className={large ? "squiggle-path" : undefined}
          pathLength={1}
          d="M4 14 C 30 4, 52 22, 80 12 S 132 4, 160 13 S 214 22, 240 11 S 282 6, 296 12"
          fill="none"
          stroke="var(--color-tomato)"
          strokeWidth={large ? 6 : 7}
          strokeLinecap="round"
        />
      </svg>
    </span>
  );

  if (large) return <h1 className="m-0">{word}</h1>;
  return (
    <Link href="/" aria-label="Scribble home" className="rounded-md focus-visible:outline-3 focus-visible:outline-offset-4 focus-visible:outline-cobalt">
      {word}
    </Link>
  );
}
