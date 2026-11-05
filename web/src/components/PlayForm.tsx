"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { useBrowserValue } from "@/lib/browser";
import { ROOM_CODE_PATTERN, USERNAME_MAX } from "@/lib/protocol";
import { loadName, saveName, validateName } from "@/lib/session";
import { createRoom, joinRoom } from "@/lib/socket";

/** Accepts "abcd2345", "ABCD 2345", or a full invite link like https://…/room/ABCD2345. */
function extractRoomCode(input: string): string {
  const lastSegment = input.trim().split("/").filter(Boolean).at(-1) ?? "";
  return lastSegment.replace(/\s+/g, "").toUpperCase();
}

export function PlayForm() {
  const router = useRouter();
  const nameId = useId();
  const codeId = useId();
  const errorId = useId();

  // The last name used pre-fills the field. Until the user types, `typed` is
  // null and we show the stored name. localStorage only exists in the
  // browser, hence useBrowserValue.
  const storedName = useBrowserValue(loadName, "");
  const [typed, setName] = useState<string | null>(null);
  const name = typed ?? storedName;
  const [busy, setBusy] = useState<"play" | "join" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showCode, setShowCode] = useState(false);
  const [code, setCode] = useState("");

  async function enter(kind: "play" | "join") {
    const nameError = validateName(name);
    if (nameError) {
      setError(nameError);
      return;
    }
    const username = name.trim();
    let roomCode = "";
    if (kind === "join") {
      roomCode = extractRoomCode(code);
      if (!ROOM_CODE_PATTERN.test(roomCode)) {
        setError("Invite codes are 8 letters and numbers, like K7MPQ2XA.");
        return;
      }
    }

    setError(null);
    setBusy(kind);
    saveName(username);
    const res = kind === "play" ? await createRoom(username) : await joinRoom(roomCode, username);
    if (res.ok) {
      router.push(`/room/${res.data.state.code}`);
      return; // keep the button busy while the next page loads
    }
    setBusy(null);
    setError(res.error.message);
  }

  function onPlay(event: FormEvent) {
    event.preventDefault();
    void enter("play");
  }

  function onJoin(event: FormEvent) {
    event.preventDefault();
    void enter("join");
  }

  return (
    <div className="w-full max-w-sm">
      <form onSubmit={onPlay} noValidate>
        <label htmlFor={nameId} className="mb-2 block text-[0.95rem] text-graphite">
          Your name
        </label>
        <div className="crayon crayon-coat">
          <input
            id={nameId}
            name="username"
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={USERNAME_MAX}
            autoComplete="nickname"
            spellCheck={false}
            placeholder="What should we call you?"
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            className="w-full bg-transparent px-5 py-4 text-xl placeholder:text-graphite/70 focus:outline-none"
          />
        </div>
        {/* Errors sit right under the field they're about. */}
        {error && (
          <p id={errorId} role="alert" className="mt-2.5 font-medium text-tomato-deep">
            {error}
          </p>
        )}

        <button
          type="submit"
          disabled={busy !== null}
          className="crayon crayon-tomato crayon-grain crayon-button font-hand mt-5 block w-full px-6 pb-2.5 pt-3 text-[2.6rem] leading-none text-ink"
        >
          {busy === "play" ? "Making your room…" : "Play"}
        </button>
        <p className="mt-3 text-[0.95rem] text-graphite">Starts a new room. Share the link with friends to play together.</p>
      </form>


      <div className="mt-8">
        {!showCode ? (
          <button
            type="button"
            onClick={() => setShowCode(true)}
            className="rounded-sm text-[1.05rem] text-cobalt underline decoration-2 underline-offset-4 hover:decoration-tomato focus-visible:outline-3 focus-visible:outline-offset-4 focus-visible:outline-cobalt"
          >
            Got an invite code?
          </button>
        ) : (
          <form onSubmit={onJoin} noValidate>
            <label htmlFor={codeId} className="mb-2 block text-[0.95rem] text-graphite">
              Invite code or link
            </label>
            <div className="flex gap-3">
              <div className="crayon crayon-coat flex-1">
                <input
                  id={codeId}
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  autoCapitalize="characters"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="K7MPQ2XA"
                  className="w-full bg-transparent px-4 py-3 text-lg uppercase tracking-[0.12em] placeholder:normal-case placeholder:tracking-normal placeholder:text-graphite/70 focus:outline-none"
                />
              </div>
              <button
                type="submit"
                disabled={busy !== null}
                className="crayon crayon-coat crayon-cobalt-line crayon-button shrink-0 px-5 font-semibold text-cobalt"
              >
                {busy === "join" ? "Joining…" : "Join room"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
