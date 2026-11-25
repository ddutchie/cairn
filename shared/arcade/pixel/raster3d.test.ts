import { describe, expect, it } from "vitest";
import { makeModel } from "./models";
import { Framebuffer3D, makeCam3D, meshFromModel, screenRay } from "./raster3d";

describe("Software 3D Rasterizer", () => {
  it("rasterizes a Z-buffered triangle and occludes farther geometry", () => {
    const fb = new Framebuffer3D(64, 64);
    fb.clearSky(10, 20, 40, 20, 40, 80);
    const cam = makeCam3D({ x: 0, y: -40, z: 10 }, { x: 0, y: 0, z: 0 }, 64, 64);

    // Far blue triangle
    fb.drawTri(cam, -20, 10, -10, 20, 10, -10, 0, 10, 20, 0, 0, 255, true);
    // Near red triangle in front of it
    fb.drawTri(cam, -10, 0, -5, 10, 0, -5, 0, 0, 15, 255, 0, 0, true);

    const mid = (32 * 64 + 32) * 4;
    expect(fb.rgba[mid]).toBeGreaterThan(200); // red wins over blue
    expect(fb.rgba[mid + 2]).toBeLessThan(80);
  });

  it("converts a voxel Model into a shaded 3D mesh and renders it", () => {
    const m = makeModel(3, 3, 3, (x, y, z) => (x === 1 && y === 1 && z === 1 ? "#ff8800" : null));
    const mesh = meshFromModel(m, 2);
    expect(mesh.tris.length).toBe(10); // 5 exposed faces (no bottom) * 2 tris

    const fb = new Framebuffer3D(40, 40);
    fb.clearSky(0, 0, 0, 0, 0, 0);
    const cam = makeCam3D({ x: 0, y: -16, z: 12 }, { x: 0, y: 0, z: 3 }, 40, 40);
    fb.drawMesh(cam, mesh, 0, 0, 0);

    let lit = 0;
    for (let i = 0; i < fb.rgba.length; i += 4) {
      if (fb.rgba[i] > 100) lit++;
    }
    expect(lit).toBeGreaterThan(5);
  });

  it("casts center screen ray straight toward the camera target", () => {
    const cam = makeCam3D({ x: 0, y: -50, z: 25 }, { x: 0, y: 0, z: 0 }, 100, 80);
    const ray = screenRay(cam, 50, 40);
    expect(ray.dir.y).toBeGreaterThan(0.8);
    expect(ray.dir.z).toBeLessThan(-0.3);
  });
});
