/**
 * Brick Breaker voxel models: 24x8x3 entity blocks and 32x7x3 hover paddle.
 */

import { ICONS, KINDS, type EntityKind } from "../pixel/kinds";
import { makeModel, type Model } from "../pixel/models";

export const PAD_W = 32;

function brick(kind: EntityKind): Model {
  const K = KINDS[kind];
  const ic = ICONS[kind];
  return makeModel(24, 8, 3, (x, y, z) => {
    if (z < 2) return z === 0 ? K.d : K.h;
    const ix = x - 2, iy = y - 1;
    if (ix >= 0 && ix < 5 && iy >= 0 && iy < 5 && ic.charCodeAt(iy * 5 + ix) === 49) return K.l;
    if (y === 0) return K.l;
    return (x + y) % 7 === 0 && x > 8 ? K.d : K.h;
  });
}

export const BRICKS: Record<EntityKind, Model> = {
  project: brick("project"),
  note: brick("note"),
  card: brick("card"),
  tag: brick("tag"),
};

export const PADDLE: Model = makeModel(PAD_W, 7, 3, (x, y, z) => {
  const edge = x === 0 || x === PAD_W - 1;
  if (z === 0) return x > 2 && x < PAD_W - 3 ? "#343b4c" : null;
  if (z === 1) return edge && (y < 1 || y > 5) ? null : "#6b7488";
  if (y === 0 || y === 6 || edge) return null;
  if (y === 3 && (x < 4 || x > PAD_W - 5)) return "#2ec4b6";
  if (y === 3 && x > 12 && x < PAD_W - 13) return "#a8f4ff";
  return y === 1 ? "#d6dceb" : "#b8c2d6";
});
