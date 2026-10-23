import { describe, expect, it } from "vitest";
import { SpeechPlayer, type SpeechChunk } from "./speech-player.ts";

function chunk(id: string, utteranceId: string): SpeechChunk {
  return { id, utteranceId, audioBase64: "x", mime: "audio/mpeg" };
}

function makePlayer(): { player: SpeechPlayer; played: string[]; stops: number[] } {
  const played: string[] = [];
  const stops: number[] = [];
  const done: Array<() => void> = [];
  const player = new SpeechPlayer(
    (item, onDone) => {
      played.push(item.id);
      done.push(onDone);
    },
    () => stops.push(1),
  );
  return { player, played, stops };
}

describe("播报队列", () => {
  it("同一句的几段按顺序播，不互相打断", () => {
    const { player, played, stops } = makePlayer();
    player.push(chunk("u1:0", "u1"));
    player.push(chunk("u1:1", "u1"));
    player.push(chunk("u1:2", "u1"));
    expect(played).toEqual(["u1:0"]);
    expect(player.pending).toBe(2);
    expect(stops).toHaveLength(0);
  });

  it("新的一句会抢占：停掉旧的、清空队列", () => {
    const { player, played, stops } = makePlayer();
    player.push(chunk("u1:0", "u1"));
    player.push(chunk("u1:1", "u1"));
    player.push(chunk("u2:0", "u2"));
    expect(stops.length).toBeGreaterThan(0);
    expect(played).toEqual(["u1:0", "u2:0"]);
    expect(player.pending).toBe(0);
    expect(player.currentUtterance).toBe("u2");
  });

  it("没有 utteranceId 时按 id 自己算一句", () => {
    const { player, played } = makePlayer();
    player.push({ id: "a", audioBase64: "x", mime: "audio/mpeg" });
    player.push({ id: "b", audioBase64: "x", mime: "audio/mpeg" });
    // 两个不同 id = 两句，后者抢占前者
    expect(played).toEqual(["a", "b"]);
    expect(player.currentUtterance).toBe("b");
  });

  it("clear 之后什么都不放", () => {
    const { player, played } = makePlayer();
    player.push(chunk("u1:0", "u1"));
    player.clear();
    expect(player.pending).toBe(0);
    expect(played).toEqual(["u1:0"]);
  });
});
