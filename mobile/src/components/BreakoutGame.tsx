import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  View,
  Text,
  Modal,
  Pressable,
  StyleSheet,
  PanResponder,
  AppState,
  useWindowDimensions,
} from "react-native";
import { X } from "lucide-react-native";
import { listBreakoutBricks, type BrickKind } from "@/db/queries";
import { haptics } from "@/haptics";
import { useTheme, type as typeScale, type Theme } from "@/theme";

// ── Layout / physics constants ────────────────────────────────────────────────
const BRICK_ROWS = 7;
const BRICK_COLS = 6;
const BRICK_GAP = 5;
const BRICK_H = 22;
const PADDLE_W = 92;
const PADDLE_H = 12;
const BALL_R = 7;
const WALL_PAD = 12;
const BASE_SPEED = 5.4; // px per frame at 60fps
// Paddle sits ~20% of the field height up from the bottom (not hugging it).
const PADDLE_BOTTOM_FRAC = 0.2;
// Particle burst on brick break.
const PARTICLES_PER_BREAK = 10;
const PARTICLE_LIFE = 28; // frames

interface Brick {
  x: number;
  y: number;
  w: number;
  h: number;
  kind: BrickKind;
  label: string;
  alive: boolean;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number; // remaining frames
  maxLife: number;
  color: string;
  size: number;
}

/** Brick colour by entity kind — matches the knowledge-graph token convention. */
function kindColor(kind: BrickKind, t: Theme): string {
  switch (kind) {
    case "project": return t.accent;
    case "note": return t.info;
    case "card": return t.success;
    case "tag": return t.warning;
  }
}

/** Emit a small radial burst of particles from a broken brick's centre. */
function spawnParticles(sink: Particle[], br: Brick, t: Theme): void {
  const cx = br.x + br.w / 2;
  const cy = br.y + br.h / 2;
  const color = kindColor(br.kind, t);
  for (let i = 0; i < PARTICLES_PER_BREAK; i++) {
    const ang = (Math.PI * 2 * i) / PARTICLES_PER_BREAK + Math.random() * 0.5;
    const speed = 2 + Math.random() * 3;
    sink.push({
      x: cx,
      y: cy,
      vx: Math.cos(ang) * speed,
      vy: Math.sin(ang) * speed - 1.5, // slight upward bias
      life: PARTICLE_LIFE,
      maxLife: PARTICLE_LIFE,
      color,
      size: 3 + Math.random() * 3,
    });
  }
}

/**
 * Hidden easter-egg Breakout game. The bricks are real workspace entities
 * (projects / notes / tasks / tags), coloured by kind like the knowledge graph.
 * Triggered by tapping the Cairn icon in an EmptyState 5× quickly.
 *
 * A plain requestAnimationFrame loop drives ball + paddle + brick state; the
 * handful of entities render as absolutely-positioned Views (no Skia needed).
 */
export function BreakoutGame({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const t = useTheme();
  const { width: W, height: H } = useWindowDimensions();
  const styles = useMemo(() => makeStyles(t), [t]);

  // Playfield sized to the screen, with a top band for the HUD.
  const HUD_H = 96;
  const fieldTop = HUD_H;
  const fieldBottom = H;
  // Paddle line: 25% of the field height up from the bottom.
  const paddleY = fieldBottom - (fieldBottom - fieldTop) * PADDLE_BOTTOM_FRAC;

  // Physics state lives in a stable mutable object (created once via a
  // useState initialiser — not useRef, so the strict refs-during-render lint
  // rule doesn't flag reads). The loop mutates it every frame and publishes an
  // immutable snapshot to state for rendering.
  const [gameState] = useState(() => ({
    ball: { x: W / 2, y: H / 2, vx: BASE_SPEED, vy: -BASE_SPEED },
    paddleX: W / 2 - PADDLE_W / 2,
    bricks: [] as Brick[],
    particles: [] as Particle[],
    running: false,
    paused: false,
    width: W,
    paddleY,
  }));
  gameState.width = W;
  gameState.paddleY = paddleY;
  interface Snapshot {
    ballX: number;
    ballY: number;
    paddleX: number;
    bricks: Brick[];
    particles: Particle[];
  }
  const [snap, setSnap] = useState<Snapshot>({ ballX: W / 2, ballY: H / 2, paddleX: W / 2 - PADDLE_W / 2, bricks: [], particles: [] });
  const [score, setScore] = useState(0);
  const [status, setStatus] = useState<"playing" | "won" | "lost">("playing");
  const rafRef = useRef<number | null>(null);

  const publish = useCallback(() => {
    const g = gameState;
    setSnap({ ballX: g.ball.x, ballY: g.ball.y, paddleX: g.paddleX, bricks: g.bricks, particles: g.particles });
  }, [gameState]);

  const buildBricks = useCallback((): Brick[] => {
    const labels = listBreakoutBricks(BRICK_ROWS * BRICK_COLS);
    const usableW = W - WALL_PAD * 2;
    const brickW = (usableW - BRICK_GAP * (BRICK_COLS - 1)) / BRICK_COLS;
    const bricks: Brick[] = [];
    for (let i = 0; i < labels.length; i++) {
      const row = Math.floor(i / BRICK_COLS);
      const col = i % BRICK_COLS;
      bricks.push({
        x: WALL_PAD + col * (brickW + BRICK_GAP),
        y: fieldTop + 24 + row * (BRICK_H + BRICK_GAP),
        w: brickW,
        h: BRICK_H,
        kind: labels[i].kind,
        label: labels[i].label,
        alive: true,
      });
    }
    return bricks;
  }, [W, fieldTop]);

  const reset = useCallback(() => {
    const g = gameState;
    g.ball = { x: W / 2, y: H / 2, vx: BASE_SPEED * (Math.random() > 0.5 ? 1 : -1), vy: -BASE_SPEED };
    g.paddleX = W / 2 - PADDLE_W / 2;
    g.bricks = buildBricks();
    g.particles = [];
    g.running = true;
    g.paused = AppState.currentState !== "active";
    setScore(0);
    setStatus("playing");
    publish();
  }, [W, H, buildBricks, publish, gameState]);

  // Start / stop the loop with visibility.
  useEffect(() => {
    if (!visible) {
      gameState.running = false;
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      return;
    }
    // Defer the initial reset to the first frame so we don't setState
    // synchronously inside the effect body.
    let started = false;
    const step = () => {
      if (!started) { started = true; reset(); }
      const g = gameState;
      if (g.running && !g.paused) {
        const b = g.ball;
        b.x += b.vx;
        b.y += b.vy;

        // Walls.
        if (b.x - BALL_R <= 0) { b.x = BALL_R; b.vx = Math.abs(b.vx); haptics.impact(); }
        if (b.x + BALL_R >= W) { b.x = W - BALL_R; b.vx = -Math.abs(b.vx); haptics.impact(); }
        if (b.y - BALL_R <= fieldTop) { b.y = fieldTop + BALL_R; b.vy = Math.abs(b.vy); haptics.impact(); }

        // Paddle.
        const pY = g.paddleY;
        if (
          b.vy > 0 &&
          b.y + BALL_R >= pY &&
          b.y + BALL_R <= pY + PADDLE_H + 8 &&
          b.x >= g.paddleX &&
          b.x <= g.paddleX + PADDLE_W
        ) {
          b.vy = -Math.abs(b.vy);
          // Deflect based on where it hit the paddle (-1..1).
          const hit = (b.x - (g.paddleX + PADDLE_W / 2)) / (PADDLE_W / 2);
          b.vx = hit * BASE_SPEED * 1.15;
          b.y = pY - BALL_R;
          haptics.rigid();
        }

        // Bricks.
        let liveCount = 0;
        for (const br of g.bricks) {
          if (!br.alive) continue;
          liveCount++;
          if (
            b.x + BALL_R >= br.x &&
            b.x - BALL_R <= br.x + br.w &&
            b.y + BALL_R >= br.y &&
            b.y - BALL_R <= br.y + br.h
          ) {
            br.alive = false;
            liveCount--;
            b.vy = -b.vy; // bounce vertically (simple + reliable for a grid)
            spawnParticles(g.particles, br, t);
            haptics.impactMedium();
            setScore((s) => s + 1);
            break;
          }
        }

        // Advance particles (gravity + fade), dropping dead ones.
        if (g.particles.length) {
          const alive: Particle[] = [];
          for (const p of g.particles) {
            p.x += p.vx;
            p.y += p.vy;
            p.vy += 0.35; // gravity
            p.vx *= 0.98;
            p.life -= 1;
            if (p.life > 0) alive.push(p);
          }
          g.particles = alive;
        }

        // Win / lose.
        if (liveCount === 0) {
          g.running = false;
          haptics.success();
          setStatus("won");
        } else if (b.y - BALL_R > fieldBottom) {
          g.running = false;
          haptics.error();
          setStatus("lost");
        }
      }
      publish();
      rafRef.current = requestAnimationFrame(step);
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, W, H]);

  // Pause the simulation whenever the app isn't foregrounded (notification
  // shade, app switcher, backgrounding). rAF stops when backgrounded and can
  // otherwise fire a burst of frames on return — teleporting the ball / making
  // time appear to speed up. Pausing physics (the loop keeps ticking but skips
  // integration while paused) sidesteps that entirely.
  useEffect(() => {
    if (!visible) return;
    const sub = AppState.addEventListener("change", (state) => {
      gameState.paused = state !== "active";
    });
    return () => sub.remove();
  }, [visible, gameState]);

  // Drag the paddle by touching anywhere in the field. Created once via a
  // useState initialiser (stable, no ref-during-render). The gesture callback
  // mutates the shared gameState object — which only runs on touch.
  const [pan] = useState(() =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      onPanResponderMove: (_e, gesture) => {
        const x = gesture.moveX - PADDLE_W / 2;
        gameState.paddleX = Math.max(0, Math.min(gameState.width - PADDLE_W, x));
      },
    }),
  );

  if (!visible) return null;

  return (
    <Modal visible transparent={false} animationType="fade" statusBarTranslucent onRequestClose={onClose}>
      <View style={styles.root} {...pan.panHandlers}>
        {/* HUD */}
        <View style={[styles.hud, { height: HUD_H }]}>
          <View>
            <Text style={styles.hudTitle}>Cairn Breakout</Text>
            <Text style={styles.hudScore}>Score {score}</Text>
          </View>
          <Pressable onPress={onClose} hitSlop={12} style={styles.closeBtn} accessibilityLabel="Close game">
            <X size={20} color={t.textSecondary} />
          </Pressable>
        </View>

        {/* Bricks */}
        {snap.bricks.map((br, i) =>
          br.alive ? (
            <View
              key={i}
              style={[
                styles.brick,
                {
                  left: br.x,
                  top: br.y,
                  width: br.w,
                  height: br.h,
                  backgroundColor: kindColor(br.kind, t),
                },
              ]}
            >
              <Text style={styles.brickLabel} numberOfLines={1}>{br.label}</Text>
            </View>
          ) : null,
        )}

        {/* Particles (brick-break bursts) */}
        {snap.particles.map((p, i) => (
          <View
            key={`p${i}`}
            style={{
              position: "absolute",
              left: p.x - p.size / 2,
              top: p.y - p.size / 2,
              width: p.size,
              height: p.size,
              borderRadius: p.size / 2,
              backgroundColor: p.color,
              opacity: p.life / p.maxLife,
            }}
          />
        ))}

        {/* Ball */}
        <View
          style={[
            styles.ball,
            { left: snap.ballX - BALL_R, top: snap.ballY - BALL_R, width: BALL_R * 2, height: BALL_R * 2 },
          ]}
        />

        {/* Paddle */}
        <View style={[styles.paddle, { left: snap.paddleX, top: paddleY, width: PADDLE_W, height: PADDLE_H }]} />

        {/* End overlay */}
        {status !== "playing" ? (
          <View style={styles.overlay} pointerEvents="box-none">
            <Text style={styles.overlayTitle}>{status === "won" ? "Cleared!" : "Game over"}</Text>
            <Text style={styles.overlaySub}>Score {score}</Text>
            <Pressable onPress={reset} style={styles.playAgain}>
              <Text style={styles.playAgainText}>Play again</Text>
            </Pressable>
            <Pressable onPress={onClose} hitSlop={12} style={styles.overlayClose}>
              <Text style={styles.overlayCloseText}>Close</Text>
            </Pressable>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

function makeStyles(t: Theme) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: t.background },
    hud: {
      flexDirection: "row",
      alignItems: "flex-end",
      justifyContent: "space-between",
      paddingHorizontal: 18,
      paddingBottom: 10,
    },
    hudTitle: { ...typeScale.title, color: t.textPrimary },
    hudScore: { ...typeScale.caption, color: t.textTertiary, marginTop: 2, fontVariant: ["tabular-nums"] },
    closeBtn: { padding: 6 },
    brick: {
      position: "absolute",
      borderRadius: 6,
      alignItems: "center",
      justifyContent: "center",
      paddingHorizontal: 4,
    },
    brickLabel: { ...typeScale.micro, color: "#fff", fontWeight: "600" },
    ball: { position: "absolute", borderRadius: BALL_R, backgroundColor: t.textPrimary },
    paddle: { position: "absolute", borderRadius: PADDLE_H / 2, backgroundColor: t.accent },
    overlay: {
      position: "absolute",
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: t.scrim,
    },
    overlayTitle: { ...typeScale.display, color: t.textPrimary },
    overlaySub: { ...typeScale.subtitle, color: t.textSecondary, marginTop: 6, fontVariant: ["tabular-nums"] },
    playAgain: {
      marginTop: 24,
      backgroundColor: t.accent,
      paddingHorizontal: 24,
      paddingVertical: 12,
      borderRadius: 12,
    },
    playAgainText: { ...typeScale.control, color: t.accentFg },
    overlayClose: { marginTop: 14 },
    overlayCloseText: { ...typeScale.control, color: t.textTertiary },
  });
}
