import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { View, Text, Modal, Pressable, StyleSheet, PanResponder, AppState, useWindowDimensions } from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { X } from "lucide-react-native";
import { listBreakoutBricks, type BrickKind } from "@/db/queries";
import { getMeta, setMeta } from "@/db";
import { haptics } from "@/haptics";
import { InlineConfetti } from "@/components/Confetti";
import { RollingText } from "@/components/RollingText";
import { GameOverCard, ParticlePool, PARTICLE_POOL, PopChip, useShake } from "@/components/game/GameKit";
import { comboTier, packParticles, pushTrail, seedTrail, type ComboTier } from "@/lib/game-feel";
import { useMotion } from "@/lib/use-motion";
import { useTheme, withAlpha, type as typeScale, type Theme } from "@/theme";

// Persisted best score (device-global meta — survives source switches, never synced).
const BREAKOUT_BEST_KEY = "breakout_best";
function loadBreakoutBest(): number {
  const raw = getMeta(BREAKOUT_BEST_KEY);
  const n = raw ? parseInt(raw, 10) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
}

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
const TRAIL_POINTS = 7;
const KINDS: BrickKind[] = ["project", "note", "card", "tag"];

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
  color: number; // index into the kind palette
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
function spawnParticles(sink: Particle[], br: Brick): void {
  const cx = br.x + br.w / 2;
  const cy = br.y + br.h / 2;
  const color = KINDS.indexOf(br.kind);
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
  // Keep the burst pool bounded; the oldest particles are the most faded.
  if (sink.length > PARTICLE_POOL) sink.splice(0, sink.length - PARTICLE_POOL);
}

/** The haptic detent for the nth brick in a row. */
function fireBreakHaptic(tier: ComboTier): void {
  if (tier === "flourish") haptics.impactHeavy();
  else if (tier === "thud") haptics.rigid();
  else haptics.impactMedium();
}

/**
 * Hidden easter-egg Breakout game. The bricks are real workspace entities
 * (projects / notes / tasks / tags), coloured by kind like the knowledge graph.
 * Triggered by tapping the Cairn icon in an EmptyState 5× quickly.
 *
 * A plain requestAnimationFrame loop drives the physics, but it writes shared values rather
 * than React state: the ball, its glow and trail, the paddle and the particle pool all animate
 * on the UI thread. React only re-renders when a brick breaks, the score changes or the run
 * ends.
 */
export function BreakoutGame({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const t = useTheme();
  const motion = useMotion();
  const { width: W, height: H } = useWindowDimensions();
  const styles = useMemo(() => makeStyles(t), [t]);
  const { style: shakeStyle, shake } = useShake();

  // Playfield sized to the screen, with a top band for the HUD.
  const HUD_H = 96;
  const fieldTop = HUD_H;
  const fieldBottom = H;
  // Paddle line: 20% of the field height up from the bottom.
  const paddleY = fieldBottom - (fieldBottom - fieldTop) * PADDLE_BOTTOM_FRAC;

  // Physics state lives in a stable mutable object (useState initialiser, not useRef, so the
  // refs-during-render lint rule doesn't flag reads). The loop mutates it every frame.
  const [gameState] = useState(() => ({
    ball: { x: W / 2, y: H / 2, vx: BASE_SPEED, vy: -BASE_SPEED },
    paddleX: W / 2 - PADDLE_W / 2,
    bricks: [] as Brick[],
    particles: [] as Particle[],
    trail: [] as number[],
    hadParticles: false,
    score: 0,
    streak: 0,
    running: false,
    paused: false,
    reduced: false,
    width: W,
    paddleY,
  }));
  gameState.width = W;
  gameState.paddleY = paddleY;
  gameState.reduced = motion.reduced;

  // UI-thread render state.
  const ballX = useSharedValue(W / 2);
  const ballY = useSharedValue(H / 2);
  const paddleX = useSharedValue(W / 2 - PADDLE_W / 2);
  const squash = useSharedValue(0);
  const kick = useSharedValue(0);
  const trail = useSharedValue<number[]>(seedTrail(W / 2, H / 2, TRAIL_POINTS));
  const particleBuf = useSharedValue<number[]>(packParticles([], PARTICLE_POOL));

  const [bricks, setBricks] = useState<Brick[]>([]);
  const [score, setScore] = useState(0);
  const [streak, setStreak] = useState(0);
  const [best, setBest] = useState(loadBreakoutBest);
  const [newRecord, setNewRecord] = useState(false);
  const [status, setStatus] = useState<"playing" | "won" | "lost">("playing");
  // Bumped to fire a confetti burst inside the Modal on a win (the app-root
  // ConfettiHost renders behind this fullscreen Modal). 0 = idle.
  const [celebrate, setCelebrate] = useState(0);
  const rafRef = useRef<number | null>(null);

  const buildBricks = useCallback((): Brick[] => {
    const labels = listBreakoutBricks(BRICK_ROWS * BRICK_COLS);
    const usableW = W - WALL_PAD * 2;
    const brickW = (usableW - BRICK_GAP * (BRICK_COLS - 1)) / BRICK_COLS;
    const out: Brick[] = [];
    for (let i = 0; i < labels.length; i++) {
      const row = Math.floor(i / BRICK_COLS);
      const col = i % BRICK_COLS;
      out.push({
        x: WALL_PAD + col * (brickW + BRICK_GAP),
        y: fieldTop + 24 + row * (BRICK_H + BRICK_GAP),
        w: brickW,
        h: BRICK_H,
        kind: labels[i].kind,
        label: labels[i].label,
        alive: true,
      });
    }
    return out;
  }, [W, fieldTop]);

  const reset = useCallback(() => {
    const g = gameState;
    g.ball = { x: W / 2, y: H / 2, vx: BASE_SPEED * (Math.random() > 0.5 ? 1 : -1), vy: -BASE_SPEED };
    g.paddleX = W / 2 - PADDLE_W / 2;
    g.bricks = buildBricks();
    g.particles = [];
    g.trail = seedTrail(g.ball.x, g.ball.y, TRAIL_POINTS);
    g.hadParticles = false;
    g.score = 0;
    g.streak = 0;
    g.running = true;
    g.paused = AppState.currentState !== "active";
    ballX.set(g.ball.x);
    ballY.set(g.ball.y);
    paddleX.set(g.paddleX);
    trail.set(g.trail);
    particleBuf.set(packParticles([], PARTICLE_POOL));
    setBricks(g.bricks.map((b) => ({ ...b })));
    setScore(0);
    setStreak(0);
    setNewRecord(false);
    setStatus("playing");
    setCelebrate(0);
  }, [W, H, buildBricks, gameState, ballX, ballY, paddleX, trail, particleBuf]);

  /** Persist a new personal best and report whether this run set one. */
  const settleBest = useCallback((final: number): boolean => {
    const record = final > loadBreakoutBest();
    if (record) setMeta(BREAKOUT_BEST_KEY, String(final));
    setBest((b) => Math.max(b, final));
    setNewRecord(record);
    return record;
  }, []);

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
          if (!g.reduced) {
            // The paddle squashes on impact and springs back; the ball's glow flares.
            squash.set(withSequence(withTiming(1, { duration: 30 }), withSpring(0, { damping: 12, stiffness: 700 })));
            kick.set(withSequence(withTiming(1, { duration: 30 }), withTiming(0, { duration: 160 })));
          }
          if (g.streak > 0) { g.streak = 0; setStreak(0); }
        }

        // Bricks: handle at most one collision this frame, then count how many
        // bricks remain alive. The collision detection breaks out early, so the
        // live count MUST be computed in its own pass over every brick —
        // otherwise a hit on an early brick makes it look like the board is
        // clear (false "won").
        for (const br of g.bricks) {
          if (!br.alive) continue;
          if (
            b.x + BALL_R >= br.x &&
            b.x - BALL_R <= br.x + br.w &&
            b.y + BALL_R >= br.y &&
            b.y - BALL_R <= br.y + br.h
          ) {
            br.alive = false;
            b.vy = -b.vy; // bounce vertically (simple + reliable for a grid)
            if (!g.reduced) {
              spawnParticles(g.particles, br);
              kick.set(withSequence(withTiming(1, { duration: 25 }), withTiming(0, { duration: 140 })));
            }
            g.streak += 1;
            g.score += 1;
            fireBreakHaptic(comboTier(g.streak));
            setStreak(g.streak);
            setScore(g.score);
            setBricks(g.bricks.map((x) => ({ ...x })));
            break;
          }
        }
        let liveCount = 0;
        for (const br of g.bricks) if (br.alive) liveCount++;

        // Ball position + trail go straight to the UI thread.
        ballX.set(b.x);
        ballY.set(b.y);
        if (!g.reduced) {
          g.trail = pushTrail(g.trail, b.x, b.y, TRAIL_POINTS);
          trail.set(g.trail);
        }

        // Win / lose.
        if (liveCount === 0) {
          g.running = false;
          haptics.success();
          settleBest(g.score);
          setStatus("won");
          // Clearing every brick is the big moment — celebrate with confetti.
          if (!g.reduced) setCelebrate((n) => n + 1);
        } else if (b.y - BALL_R > fieldBottom) {
          g.running = false;
          haptics.error();
          shake();
          settleBest(g.score);
          setStatus("lost");
        }
      }
      if (!g.paused) {
        // Advance particles (gravity + fade), dropping dead ones — also after the run ends,
        // so the last burst finishes instead of freezing on screen.
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
        // Write the pool while anything is alive, plus one final clearing write.
        if (g.particles.length || g.hadParticles) {
          particleBuf.set(packParticles(g.particles, PARTICLE_POOL));
          g.hadParticles = g.particles.length > 0;
        }
      }
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
        paddleX.set(gameState.paddleX);
      },
    }),
  );

  const palette = useMemo(() => KINDS.map((k) => kindColor(k, t)), [t]);
  const glowColor = useMemo(() => withAlpha(t.accent, 0.35), [t]);

  const paddleStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: paddleX.get() },
      { scaleX: 1 + squash.get() * 0.14 },
      { scaleY: 1 - squash.get() * 0.45 },
    ],
  }));
  const ballStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: ballX.get() - BALL_R }, { translateY: ballY.get() - BALL_R }],
  }));
  const glowStyle = useAnimatedStyle(() => ({
    opacity: 0.55 + kick.get() * 0.45,
    transform: [
      { translateX: ballX.get() - BALL_R * 2.6 },
      { translateY: ballY.get() - BALL_R * 2.6 },
      { scale: 1 + kick.get() * 0.7 },
    ],
  }));

  if (!visible) return null;

  const best2 = Math.max(best, score);

  return (
    <Modal visible transparent={false} animationType="fade" statusBarTranslucent onRequestClose={onClose}>
      <View style={styles.root} {...pan.panHandlers}>
        <Animated.View style={[StyleSheet.absoluteFill, shakeStyle]}>
          {/* HUD */}
          <View style={[styles.hud, { height: HUD_H }]}>
            <View>
              <Text style={styles.hudTitle}>Cairn Breakout</Text>
              <View style={styles.hudRow}>
                <Text style={styles.hudScore}>Score </Text>
                <RollingText text={String(score)} style={styles.hudScore} />
                {streak >= 2 ? (
                  <PopChip pulseKey={streak}>
                    <Text style={styles.hudStreak}>{`  ·  ${streak}× streak`}</Text>
                  </PopChip>
                ) : null}
              </View>
            </View>
            <Pressable onPress={onClose} hitSlop={12} style={styles.closeBtn} accessibilityLabel="Close game">
              <X size={20} color={t.textSecondary} />
            </Pressable>
          </View>

          {/* Bricks */}
          {bricks.map((br, i) => (
            <BrickView key={i} brick={br} color={palette[KINDS.indexOf(br.kind)]} labelColor={t.accentFg} />
          ))}

          {/* Particles (brick-break bursts) */}
          <ParticlePool data={particleBuf} palette={palette} />

          {/* Ball trail, glow and ball */}
          {Array.from({ length: TRAIL_POINTS - 1 }, (_, i) => (
            <TrailDot key={i} index={i + 1} trail={trail} color={t.textPrimary} />
          ))}
          <Animated.View
            pointerEvents="none"
            style={[styles.glow, { backgroundColor: glowColor }, glowStyle]}
          />
          <Animated.View pointerEvents="none" style={[styles.ball, ballStyle]} />

          {/* Paddle */}
          <Animated.View style={[styles.paddle, { top: paddleY }, paddleStyle]} />
        </Animated.View>

        {/* End overlay */}
        {status !== "playing" ? (
          <GameOverCard
            title={status === "won" ? "Cleared!" : newRecord ? "New high score!" : "Game over"}
            scoreLabel="Score"
            score={score}
            bestLine={best2 > 0 ? (newRecord ? `New best ${best2}` : `Best ${best2}`) : undefined}
            record={newRecord}
            primaryLabel="Play again"
            onPrimary={reset}
            onClose={onClose}
          />
        ) : null}

        {/* Confetti on clearing the board — inside the Modal so it shows over
            the game (the app-root host sits behind it). */}
        <InlineConfetti fireKey={celebrate} />
      </View>
    </Modal>
  );
}

/** A brick that shrinks and fades when it breaks. */
const BrickView = memo(function BrickView({ brick, color, labelColor }: { brick: Brick; color: string; labelColor: string }) {
  const motion = useMotion();
  const alive = useSharedValue(1);
  useEffect(() => {
    alive.set(brick.alive ? 1 : motion.reduced ? 0 : withTiming(0, { duration: 110 }));
  }, [brick.alive, motion.reduced, alive]);
  const style = useAnimatedStyle(() => ({
    opacity: alive.get(),
    transform: [{ scale: 1 + (1 - alive.get()) * 0.18 }],
  }));
  if (!brick.alive && motion.reduced) return null;
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        brickStyles.brick,
        { left: brick.x, top: brick.y, width: brick.w, height: brick.h, backgroundColor: color },
        style,
      ]}
    >
      <Text style={[brickStyles.label, { color: labelColor }]} numberOfLines={1}>{brick.label}</Text>
    </Animated.View>
  );
});

/** One fading dot of the ball's trail, reading its own point from the shared history. */
const TrailDot = memo(function TrailDot({ index, trail, color }: { index: number; trail: ReturnType<typeof useSharedValue<number[]>>; color: string }) {
  const frac = 1 - index / TRAIL_POINTS;
  const size = BALL_R * 2 * (0.35 + 0.65 * frac);
  const style = useAnimatedStyle(() => {
    const d = trail.get();
    return {
      transform: [{ translateX: (d[index * 2] ?? 0) - size / 2 }, { translateY: (d[index * 2 + 1] ?? 0) - size / 2 }],
    };
  });
  return (
    <Animated.View
      pointerEvents="none"
      style={[{ position: "absolute", left: 0, top: 0, width: size, height: size, borderRadius: size / 2, backgroundColor: color, opacity: 0.32 * frac }, style]}
    />
  );
});

const brickStyles = StyleSheet.create({
  brick: {
    position: "absolute",
    borderRadius: 6,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: 4,
  },
  label: { ...typeScale.micro, fontWeight: "600" },
});

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
    hudRow: { flexDirection: "row", alignItems: "center", marginTop: 2 },
    hudScore: { ...typeScale.caption, color: t.textTertiary, fontVariant: ["tabular-nums"] },
    hudStreak: { ...typeScale.caption, color: t.accent, fontWeight: "700" },
    closeBtn: { padding: 6 },
    glow: {
      position: "absolute",
      left: 0,
      top: 0,
      width: BALL_R * 5.2,
      height: BALL_R * 5.2,
      borderRadius: BALL_R * 2.6,
    },
    ball: { position: "absolute", left: 0, top: 0, width: BALL_R * 2, height: BALL_R * 2, borderRadius: BALL_R, backgroundColor: t.textPrimary },
    paddle: { position: "absolute", left: 0, width: PADDLE_W, height: PADDLE_H, borderRadius: PADDLE_H / 2, backgroundColor: t.accent },
  });
}
