/**
 * led.ts — profils LED : lumieres etendues (lignes ou rectangle).
 *
 * Une `PointLight` rayonne d'un point, dans toutes les directions. Un ruban de
 * LED dans une sanca, ou un panneau au plafond, n'eclaire ni depuis son centre
 * ni derriere lui : on utilise donc une `RectAreaLight`, qui emet d'une
 * surface, par une seule face.
 *
 * Deux limites de la RectAreaLight, assumees :
 *   - elle ne projette pas d'ombre ;
 *   - son cout par pixel croit avec leur nombre (integrale LTC), d'ou le plafond
 *     `ledAreaLights` du profil qualite. Au-dela, le profil retombe sur une seule
 *     PointLight en son centre, qui garde au moins l'ambiance de la piece.
 *
 * Toute la geometrie est relative a la position de l'ancre, voir `LedProfile`.
 */
import * as THREE from 'three';
import { RectAreaLightUniformsLib } from 'three/examples/jsm/lights/RectAreaLightUniformsLib.js';
import type { LedProfile, LedSegment, LedShape, LightStyle } from './types';

/**
 * Unite de longueur du profil, deduite de l'envergure du modele.
 *
 * Meme formule que le rayon des marqueurs de l'editeur : un export Sweet Home 3D
 * est en centimetres et l'utilisateur n'a pas a connaitre l'unite de son GLB.
 */
export function ledUnit(span?: number): number {
  return Math.max(0.03, (span && span > 0 ? span : 12) * 0.012);
}

/** Largeur visible et eclairante d'un ruban, en unites de profil. */
const STRIP_WIDTH = 0.6;
/** Ecart du panneau visible par rapport au plan d'emission, contre le z-fighting. */
const LIFT = 0.05;

const OFF_COLOR = 0x39414d;
const DOWN = new THREE.Vector3(0, -1, 0);

/** Sens d'emission normalise ; vers le bas par defaut, comme un spot. */
export function emissionDir(direction?: [number, number, number]): THREE.Vector3 {
  const d = direction ? new THREE.Vector3(...direction) : DOWN.clone();
  return d.lengthSq() < 1e-8 ? DOWN.clone() : d.normalize();
}

/**
 * Repere (u, v) du plan d'un rectangle dont la normale est le sens d'emission.
 * `spin` tourne ce repere autour de la normale.
 */
export function ledFrame(e: THREE.Vector3, spin = 0): { u: THREE.Vector3; v: THREE.Vector3 } {
  const ref = Math.abs(e.y) < 0.99 ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
  const u = new THREE.Vector3().crossVectors(ref, e).normalize();
  const v = new THREE.Vector3().crossVectors(e, u).normalize();
  if (spin) {
    const q = new THREE.Quaternion().setFromAxisAngle(e, spin);
    u.applyQuaternion(q);
    v.applyQuaternion(q);
  }
  return { u, v };
}

/** Profil par defaut d'une forme, centre sur l'ancre et pose dans le plan d'emission. */
export function defaultLed(
  shape: LedShape,
  unit: number,
  direction?: [number, number, number],
): LedProfile {
  if (shape === 'rect') return { shape, size: [unit * 14, unit * 14], spin: 0 };
  if (shape === 'spots') return { shape, points: [[0, 0, 0]] };
  const { u } = ledFrame(emissionDir(direction));
  const h = unit * 8;
  return {
    shape,
    segments: [[
      [-u.x * h, -u.y * h, -u.z * h],
      [u.x * h, u.y * h, u.z * h],
    ]],
  };
}

/** Nouveau segment, parallele au dernier et decale de `gap` dans le plan d'emission. */
export function nextSegment(
  led: LedProfile,
  unit: number,
  direction?: [number, number, number],
): LedSegment {
  const segs = led.segments ?? [];
  const last = segs[segs.length - 1];
  if (!last) return defaultLed('lines', unit, direction).segments![0];
  const e = emissionDir(direction);
  const axis = new THREE.Vector3(...last[1]).sub(new THREE.Vector3(...last[0]));
  const side = new THREE.Vector3().crossVectors(e, axis);
  if (side.lengthSq() < 1e-10) side.copy(ledFrame(e).v);
  side.normalize().multiplyScalar(unit * 5);
  const shift = (p: [number, number, number]): [number, number, number] =>
    [p[0] + side.x, p[1] + side.y, p[2] + side.z];
  return [shift(last[0]), shift(last[1])];
}

/** Nouveau spot, decale du dernier dans le plan d'emission. */
export function nextPoint(
  led: LedProfile,
  unit: number,
  direction?: [number, number, number],
): [number, number, number] {
  const pts = led.points ?? [];
  const last = pts[pts.length - 1] ?? [0, 0, 0];
  const { u } = ledFrame(emissionDir(direction));
  return [last[0] + u.x * unit * 8, last[1] + u.y * unit * 8, last[2] + u.z * unit * 8];
}

/** Une surface emettrice : un segment ou le rectangle entier. */
export interface LedPrimitive {
  center: THREE.Vector3;
  /** Repere dont -Z est le sens d'emission, tel que RectAreaLight l'attend. */
  quaternion: THREE.Quaternion;
  width: number;
  height: number;
}

/** Surfaces emettrices d'un profil, en coordonnees du monde. */
export function ledPrimitives(
  led: LedProfile,
  position: THREE.Vector3,
  direction: [number, number, number] | undefined,
  unit: number,
): LedPrimitive[] {
  const e = emissionDir(direction);

  // Un rectangle est un cadre : quatre rubans le long de ses bords, comme un
  // profil de LED encadrant un plafonnier, pas un panneau plein.
  let segments: LedSegment[] = led.segments ?? [];
  if (led.shape === 'rect') {
    const [w, h] = rectSize(led, unit);
    const { u, v } = ledFrame(e, led.spin);
    const t = Math.min(unit * STRIP_WIDTH, w / 2, h / 2);
    const at = (a: number, b: number): [number, number, number] => [
      u.x * a + v.x * b, u.y * a + v.y * b, u.z * a + v.z * b,
    ];
    const hw = w / 2, hh = h / 2;
    segments = [
      [at(-hw, hh - t / 2), at(hw, hh - t / 2)],
      [at(-hw, -hh + t / 2), at(hw, -hh + t / 2)],
      [at(hw - t / 2, -hh + t), at(hw - t / 2, hh - t)],
      [at(-hw + t / 2, -hh + t), at(-hw + t / 2, hh - t)],
    ];
  }

  const out: LedPrimitive[] = [];
  for (const [a, b] of segments) {
    const pa = position.clone().add(new THREE.Vector3(...a));
    const pb = position.clone().add(new THREE.Vector3(...b));
    const axis = pb.clone().sub(pa);
    const length = axis.length();
    if (length < 1e-6) continue;
    axis.divideScalar(length);

    // Le sens d'emission est ramene dans le plan perpendiculaire au segment ;
    // un segment pose le long de l'emission n'a pas de face, on prend alors un
    // perpendiculaire quelconque.
    const lateral = e.clone().addScaledVector(axis, -e.dot(axis));
    if (lateral.lengthSq() < 1e-8) lateral.copy(ledFrame(axis).u);
    lateral.normalize();

    const z = lateral.clone().negate();
    const y = new THREE.Vector3().crossVectors(z, axis);
    out.push({
      center: pa.add(pb).multiplyScalar(0.5),
      quaternion: basis(axis, y, z),
      width: length,
      height: led.shape === 'rect'
        ? Math.min(unit * STRIP_WIDTH, rectSize(led, unit)[0] / 2, rectSize(led, unit)[1] / 2)
        : unit * STRIP_WIDTH,
    });
  }
  return out;
}

/** Dimensions du rectangle exterieur, jamais nulles. */
export function rectSize(led: LedProfile, unit: number): [number, number] {
  const [w, h] = led.size ?? [unit * 14, unit * 14];
  return [Math.max(w, unit * 0.2), Math.max(h, unit * 0.2)];
}

function basis(x: THREE.Vector3, y: THREE.Vector3, z: THREE.Vector3): THREE.Quaternion {
  return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
}

// ── Rig ──────────────────────────────────────────────────────────────────────

export interface LedRig {
  group: THREE.Group;
  /** `area` : RectAreaLight par ruban ; `point` : repli sur une PointLight ; `spots` : une lampe par spot. */
  mode: 'area' | 'point' | 'spots';
  lights: THREE.Light[];
  /** Surface emettrice totale : repartit la puissance entre les segments. */
  totalArea: number;
  /** Materiaux emissifs : l'eclat visible du profil. */
  materials: THREE.MeshBasicMaterial[];
  /** Etat anime, comme `light.intensity` pour une lampe classique. */
  current: { intensity: number; color: THREE.Color };
  /** Empreinte de la configuration : evite de reconstruire pour rien. */
  signature: string;
}

export interface LedRigOptions {
  led: LedProfile;
  position: THREE.Vector3;
  direction?: [number, number, number];
  unit: number;
  /** Style des spots (`spots` seulement) : `point` ampoule, `spot` cone large, `beam` cone etroit. */
  style?: LightStyle;
  /** RectAreaLight encore disponibles ; sinon le profil retombe sur une PointLight. */
  areaBudget: { left: number };
  pointDistance: number;
  pointDecay: number;
}

/**
 * Gain des RectAreaLight par rapport a la puissance equivalente d'une lampe
 * ponctuelle. Releve au banc d'essai (dev/led-harness.html) : a puissance egale,
 * une surface eclaire une piece nettement moins qu'un point place au plafond,
 * parce que la moitie de son flux part dans la dalle contre laquelle elle est posee.
 */
export const AREA_GAIN = 4;

let libReady = false;

/** Signature de ce qui change la geometrie ou le mode d'un rig. */
export function ledSignature(
  led: LedProfile,
  position: THREE.Vector3,
  direction?: [number, number, number],
  style?: LightStyle,
): string {
  return JSON.stringify([led, position.toArray(), direction ?? null, led.shape === 'spots' ? style ?? 'point' : null]);
}

/** Des spots isoles : une lampe et une pastille visible par point. */
function buildSpotsRig(o: LedRigOptions): LedRig {
  const group = new THREE.Group();
  const lights: THREE.Light[] = [];
  const materials: THREE.MeshBasicMaterial[] = [];
  const e = emissionDir(o.direction);
  const style = o.style ?? 'point';
  const reach = o.pointDistance * (style === 'point' ? 1 : 1.5);

  for (const p of o.led.points ?? []) {
    const pos = o.position.clone().add(new THREE.Vector3(...p));
    const mat = new THREE.MeshBasicMaterial({ color: OFF_COLOR, toneMapped: false });
    const dot = new THREE.Mesh(new THREE.SphereGeometry(o.unit * 0.5, 12, 8), mat);
    dot.position.copy(pos);
    dot.renderOrder = 1;
    dot.userData.ledMesh = true;
    group.add(dot);
    materials.push(mat);

    let light: THREE.Light;
    if (style === 'point') {
      light = new THREE.PointLight(0xffffff, 0, reach, o.pointDecay);
    } else {
      const spot = new THREE.SpotLight(
        0xffffff, 0, reach,
        style === 'spot' ? Math.PI / 5 : Math.PI / 10,
        style === 'spot' ? 0.25 : 0.04,
        o.pointDecay,
      );
      spot.target.position.copy(pos).addScaledVector(e, 4);
      group.add(spot.target);
      light = spot;
    }
    light.position.copy(pos);
    light.visible = false;
    group.add(light);
    lights.push(light);
  }

  return {
    group, mode: 'spots', lights, totalArea: 0, materials,
    current: { intensity: 0, color: new THREE.Color(0xffffff) },
    signature: ledSignature(o.led, o.position, o.direction, o.style),
  };
}

export function buildLedRig(o: LedRigOptions): LedRig {
  if (o.led.shape === 'spots') return buildSpotsRig(o);
  const prims = ledPrimitives(o.led, o.position, o.direction, o.unit);
  const group = new THREE.Group();
  const lights: THREE.Light[] = [];
  const materials: THREE.MeshBasicMaterial[] = [];
  const totalArea = prims.reduce((s, p) => s + p.width * p.height, 0);
  const e = emissionDir(o.direction);

  // Le panneau visible : decale du plan d'emission, face tournee vers la piece.
  for (const p of prims) {
    // Double face : la face visible regarde la piece, et la camera de l'editeur
    // voit souvent un plafond par le dessus, donc le dos du panneau.
    const mat = new THREE.MeshBasicMaterial({ color: OFF_COLOR, toneMapped: false, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(p.width, p.height), mat);
    mesh.position.copy(p.center).addScaledVector(e, o.unit * LIFT);
    // Le plan regarde +Z, la RectAreaLight emet vers -Z : on retourne le maillage.
    mesh.quaternion.copy(p.quaternion).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI));
    mesh.renderOrder = 1;
    mesh.userData.ledMesh = true;
    group.add(mesh);
    materials.push(mat);
  }

  const useArea = prims.length > 0 && o.areaBudget.left >= prims.length;
  if (useArea) {
    if (!libReady) { RectAreaLightUniformsLib.init(); libReady = true; }
    o.areaBudget.left -= prims.length;
    for (const p of prims) {
      const light = new THREE.RectAreaLight(0xffffff, 0, p.width, p.height);
      light.position.copy(p.center);
      light.quaternion.copy(p.quaternion);
      light.visible = false;
      group.add(light);
      lights.push(light);
    }
  } else if (prims.length) {
    // Une seule lampe au barycentre, poussee du cote de l'emission pour ne pas
    // eclairer la dalle ou le mur dans lequel le profil est encastre.
    const c = new THREE.Vector3();
    prims.forEach((p) => c.add(p.center));
    c.divideScalar(prims.length).addScaledVector(e, o.unit * 6);
    const light = new THREE.PointLight(0xffffff, 0, o.pointDistance, o.pointDecay);
    light.position.copy(c);
    light.visible = false;
    group.add(light);
    lights.push(light);
  }

  return {
    group,
    mode: useArea ? 'area' : 'point',
    lights,
    totalArea,
    materials,
    current: { intensity: 0, color: new THREE.Color(0xffffff) },
    signature: ledSignature(o.led, o.position, o.direction, o.style),
  };
}

/**
 * Applique l'etat courant du rig : intensite des lumieres et eclat des panneaux.
 *
 * `intensity` est l'intensite equivalente d'une lampe ponctuelle ; `full` celle
 * de la lampe a pleine puissance, qui borne l'eclat visible. Une RectAreaLight
 * eclaire a hauteur de sa luminance fois sa surface : pour qu'un profil ait la
 * meme puissance totale qu'une lampe ponctuelle, on la divise par la surface.
 */
export function applyLedState(rig: LedRig, intensity: number, color: THREE.Color, full: number): void {
  const lit = intensity > 0.01;
  const radiance = rig.mode === 'area' && rig.totalArea > 0 ? (intensity * AREA_GAIN) / rig.totalArea : intensity;

  for (const light of rig.lights) {
    light.intensity = radiance;
    light.color.copy(color);
    light.visible = lit;
  }

  const b = full > 0 ? THREE.MathUtils.clamp(intensity / full, 0, 1) : 0;
  const off = new THREE.Color(OFF_COLOR);
  for (const m of rig.materials) m.color.copy(off).lerp(color, b);
}

/** Avance le rig vers sa cible ; vrai tant qu'une transition est en cours. */
export function stepLedRig(
  rig: LedRig,
  targetIntensity: number,
  targetColor: THREE.Color,
  full: number,
  alpha: number,
): boolean {
  const c = rig.current;
  const moving = Math.abs(c.intensity - targetIntensity) > 0.002
    || Math.abs(c.color.r - targetColor.r) > 0.002
    || Math.abs(c.color.g - targetColor.g) > 0.002
    || Math.abs(c.color.b - targetColor.b) > 0.002;

  if (moving) {
    c.intensity = THREE.MathUtils.lerp(c.intensity, targetIntensity, alpha);
    c.color.lerp(targetColor, alpha);
  } else {
    c.intensity = targetIntensity;
    c.color.copy(targetColor);
  }
  applyLedState(rig, c.intensity, c.color, full);
  return moving;
}

export function disposeLedRig(rig: LedRig, scene: THREE.Scene): void {
  scene.remove(rig.group);
  rig.group.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (mesh.isMesh) { mesh.geometry.dispose(); (mesh.material as THREE.Material).dispose(); }
    if ((o as THREE.Light).isLight) (o as THREE.Light).dispose();
  });
}
