import Image from "next/image";
import { PlayForm } from "@/components/PlayForm";
import { Wordmark } from "@/components/Wordmark";

export default function HomePage() {
  return (
    <main className="mx-auto grid min-h-dvh w-full max-w-6xl items-center gap-6 px-5 py-10 sm:px-8 md:grid-cols-[1.1fr_1fr] md:gap-10 md:px-10">
      {/* On desktop the pair walks right, toward the form. On mobile the form comes first. */}
      <div className="order-2 flex justify-center md:order-1 md:justify-end">
        <Image
          src="/illustrations/walkers.webp"
          width={734}
          height={820}
          preload
          sizes="(min-width: 768px) 520px, 320px"
          alt="Two friends in winter coats and hats walking side by side, one carrying a backpack and a shopping basket"
          // The art's background was made transparent, so the walkers stand on the page itself.
          className="h-auto w-full max-w-[340px] md:max-w-[540px]"
        />
      </div>

      <section className="order-1 flex flex-col items-start md:order-2">
        <Wordmark />
        <p className="mt-6 mb-9 max-w-[24ch] text-[1.35rem] leading-snug text-ink sm:text-2xl">
          Take turns drawing a word while everyone else races to guess it.
        </p>
        <PlayForm />
      </section>
    </main>
  );
}
