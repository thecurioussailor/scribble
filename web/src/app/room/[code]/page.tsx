import type { Metadata } from "next";
import { Suspense } from "react";
import { RoomClientLoader } from "@/components/RoomClientLoader";

export const metadata: Metadata = {
  title: "Your room | Scribble",
};

/**
 * With Cache Components (next.config.ts), a dynamic param is only known at
 * request time, so reading it must happen inside a <Suspense> boundary.
 * The fallback is prerendered, and the rest streams in.
 */
export default function RoomPage({ params }: PageProps<"/room/[code]">) {
  return (
    <Suspense fallback={<RoomFallback />}>
      <RoomWithCode params={params} />
    </Suspense>
  );
}

async function RoomWithCode({ params }: { params: PageProps<"/room/[code]">["params"] }) {
  const { code } = await params;
  return <RoomClientLoader code={code.toUpperCase()} />;
}

function RoomFallback() {
  return <p className="p-10 text-lg text-graphite">Opening the room…</p>;
}
