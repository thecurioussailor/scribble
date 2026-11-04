import type { Metadata, Viewport } from "next";
import { Caveat_Brush, Familjen_Grotesk } from "next/font/google";
import "./globals.css";

// Crayon-like hand lettering for the wordmark and big moments.
const caveatBrush = Caveat_Brush({
  variable: "--font-caveat-brush",
  weight: "400",
  subsets: ["latin"],
});

// A friendly, slightly quirky grotesque for everything people read.
const familjen = Familjen_Grotesk({
  variable: "--font-familjen",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Scribble: draw and guess with friends",
  description: "Take turns drawing a word while your friends race to guess it. Free, in the browser, with voice chat.",
};

export const viewport: Viewport = {
  themeColor: "#f0efeb",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${caveatBrush.variable} ${familjen.variable} h-full`}>
      <body className="min-h-full bg-paper text-ink">
        {/* Shared SVG filter that gives .crayon outlines their hand-drawn wobble. */}
        <svg aria-hidden="true" width="0" height="0" className="absolute">
          <filter id="crayon-wobble">
            <feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="2" seed="7" result="noise" />
            <feDisplacementMap in="SourceGraphic" in2="noise" scale="3.5" xChannelSelector="R" yChannelSelector="G" />
          </filter>
        </svg>
        {children}
      </body>
    </html>
  );
}
