import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import {
  ledUnit, emissionDir, ledFrame, defaultLed, nextSegment, ledPrimitives,
  buildLedRig, applyLedState, stepLedRig, ledSignature, AREA_GAIN, nextPoint,
} from './led.mjs';

const ORIGIN = new THREE.Vector3(0, 0, 0);
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);
const nearVec = (v, [x, y, z]) => { near(v.x, x); near(v.y, y); near(v.z, z); };
const budget = (n) => ({ left: n });

/** Sens dans lequel une RectAreaLight posee avec ce quaternion emet (-Z local). */
const emits = (q) => new THREE.Vector3(0, 0, -1).applyQuaternion(q);

test('l’unité de profil suit l’envergure du modèle, pas une valeur fixe', () => {
  assert.ok(ledUnit(618) > ledUnit(12) * 40, 'un modèle en centimètres doit avoir une unité plus grande');
  assert.equal(ledUnit(undefined), ledUnit(12));
  assert.ok(ledUnit(0.001) >= 0.03, 'plancher pour un modèle minuscule');
});

test('le sens d’emission est normalisé et vaut « vers le bas » par défaut', () => {
  nearVec(emissionDir(undefined), [0, -1, 0]);
  nearVec(emissionDir([0, 0, 0]), [0, -1, 0]);
  near(emissionDir([3, 0, 4]).length(), 1);
});

test('le repère d’un rectangle est orthonormé, y compris pour une émission verticale', () => {
  for (const dir of [[0, -1, 0], [0, 1, 0], [1, 0, 0], [0.3, -0.7, 0.2]]) {
    const e = emissionDir(dir);
    const { u, v } = ledFrame(e);
    near(u.length(), 1); near(v.length(), 1);
    near(u.dot(v), 0); near(u.dot(e), 0); near(v.dot(e), 0);
  }
});

test('un segment émet vers la pièce même si le sens demandé n’est pas perpendiculaire', () => {
  const led = { shape: 'lines', segments: [[[-2, 0, 0], [2, 0, 0]]] };
  const [p] = ledPrimitives(led, ORIGIN, [0.5, -1, 0], 0.1);
  near(p.width, 4);
  // Le composant le long du segment est retiré : l'émission reste vers le bas.
  nearVec(emits(p.quaternion), [0, -1, 0]);
});

test('un segment posé le long de l’émission reste défini, sans NaN', () => {
  const led = { shape: 'lines', segments: [[[0, -1, 0], [0, 1, 0]]] };
  const [p] = ledPrimitives(led, ORIGIN, [0, -1, 0], 0.1);
  const d = emits(p.quaternion);
  assert.ok(Number.isFinite(d.x + d.y + d.z));
  near(d.length(), 1);
});

test('un segment de longueur nulle est ignoré', () => {
  const led = { shape: 'lines', segments: [[[1, 1, 1], [1, 1, 1]], [[0, 0, 0], [1, 0, 0]]] };
  assert.equal(ledPrimitives(led, ORIGIN, undefined, 0.1).length, 1);
});

test('les segments sont relatifs à l’ancre : la déplacer déplace le profil', () => {
  const led = { shape: 'lines', segments: [[[-1, 0, 0], [1, 0, 0]]] };
  const [a] = ledPrimitives(led, new THREE.Vector3(0, 0, 0), undefined, 0.1);
  const [b] = ledPrimitives(led, new THREE.Vector3(5, 2, -3), undefined, 0.1);
  nearVec(b.center.clone().sub(a.center), [5, 2, -3]);
});

test('un rectangle émet le long de la direction demandée, au plafond comme au mur', () => {
  for (const dir of [[0, -1, 0], [1, 0, 0], [0, 0, -1]]) {
    const led = { shape: 'rect', size: [4, 2], spin: 0 };
    const prims = ledPrimitives(led, ORIGIN, dir, 0.1);
    assert.equal(prims.length, 4, 'un cadre : quatre rubans');
    for (const p of prims) nearVec(emits(p.quaternion), dir);
  }
});

test('un rectangle est un cadre : rubans sur les bords, centre vide', () => {
  const unit = 0.1;
  const prims = ledPrimitives({ shape: 'rect', size: [4, 2], spin: 0 }, ORIGIN, [0, -1, 0], unit);
  const t = unit * 0.6;
  const area = prims.reduce((s, p) => s + p.width * p.height, 0);
  near(area, 4 * 2 - (4 - 2 * t) * (2 - 2 * t), 1e-6);
  for (const p of prims) assert.ok(p.center.length() > 0.5, 'aucun ruban au centre');
});

test('la rotation d’un rectangle tourne son repère sans changer son sens d’émission', () => {
  const e = emissionDir([0, -1, 0]);
  const a = ledFrame(e, 0).u;
  const b = ledFrame(e, Math.PI / 2).u;
  near(a.dot(b), 0);
  for (const p of ledPrimitives({ shape: 'rect', size: [4, 2], spin: 1.2 }, ORIGIN, [0, -1, 0], 0.1)) {
    nearVec(emits(p.quaternion), [0, -1, 0]);
  }
});

test('un rectangle ne s’effondre jamais à zéro', () => {
  for (const p of ledPrimitives({ shape: 'rect', size: [0, 0] }, ORIGIN, undefined, 0.5)) {
    assert.ok(p.width > 0 && p.height > 0);
  }
});

test('un profil par défaut est centré sur l’ancre', () => {
  const lines = defaultLed('lines', 0.1);
  const [p0, p1] = lines.segments[0];
  near(p0[0] + p1[0], 0); near(p0[1] + p1[1], 0); near(p0[2] + p1[2], 0);
  assert.ok(Math.hypot(...p1) > 0);

  const rect = defaultLed('rect', 0.1);
  assert.equal(rect.size[0], rect.size[1], 'un carré au départ');
});

test('la ligne ajoutée est parallèle à la dernière, décalée dans le plan d’émission', () => {
  const led = defaultLed('lines', 0.1, [0, -1, 0]);
  const next = nextSegment(led, 0.1, [0, -1, 0]);
  const last = led.segments[0];
  const dirOf = ([a, b]) => new THREE.Vector3(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
  const d0 = dirOf(last).normalize();
  const d1 = dirOf(next).normalize();
  near(Math.abs(d0.dot(d1)), 1);
  const shift = new THREE.Vector3(next[0][0] - last[0][0], next[0][1] - last[0][1], next[0][2] - last[0][2]);
  assert.ok(shift.length() > 0, 'décalée');
  near(shift.y, 0);          // reste dans le plan horizontal d'un plafond
  near(shift.dot(d0), 0);    // et perpendiculaire à la ligne
});

test('la signature change avec la géométrie, la position et le sens', () => {
  const led = defaultLed('lines', 0.1);
  const base = ledSignature(led, ORIGIN, undefined);
  assert.equal(base, ledSignature(structuredClone(led), ORIGIN.clone(), undefined));
  assert.notEqual(base, ledSignature(led, new THREE.Vector3(1, 0, 0), undefined));
  assert.notEqual(base, ledSignature(led, ORIGIN, [1, 0, 0]));
  const moved = structuredClone(led);
  moved.segments[0][1][0] += 1;
  assert.notEqual(base, ledSignature(moved, ORIGIN, undefined));
});

const build = (led, left) => buildLedRig({
  led, position: ORIGIN, direction: undefined, unit: 0.1,
  areaBudget: budget(left), pointDistance: 8, pointDecay: 2,
});

test('chaque segment reçoit sa RectAreaLight tant que le budget le permet', () => {
  const led = { shape: 'lines', segments: [[[0, 0, 0], [1, 0, 0]], [[0, 0, 1], [1, 0, 1]], [[0, 0, 2], [1, 0, 2]]] };
  const b = budget(16);
  const rig = buildLedRig({ led, position: ORIGIN, unit: 0.1, areaBudget: b, pointDistance: 8, pointDecay: 2 });
  assert.equal(rig.mode, 'area');
  assert.equal(rig.lights.length, 3);
  assert.equal(rig.materials.length, 3);
  assert.equal(b.left, 13, 'le budget partagé est décompté');
});

test('sans budget, le profil retombe sur une seule PointLight', () => {
  const led = { shape: 'lines', segments: [[[0, 0, 0], [1, 0, 0]], [[0, 0, 1], [1, 0, 1]]] };
  for (const left of [0, 1]) {
    const rig = build(led, left);
    assert.equal(rig.mode, 'point', `budget ${left}`);
    assert.equal(rig.lights.length, 1);
    assert.equal(rig.lights[0].isPointLight, true);
    assert.equal(rig.materials.length, 2, 'les panneaux restent visibles');
  }
});

test('le repli ne consomme pas le budget des autres profils', () => {
  const b = budget(1);
  const led = { shape: 'lines', segments: [[[0, 0, 0], [1, 0, 0]], [[0, 0, 1], [1, 0, 1]]] };
  buildLedRig({ led, position: ORIGIN, unit: 0.1, areaBudget: b, pointDistance: 8, pointDecay: 2 });
  assert.equal(b.left, 1);
});

test('la puissance d’un profil est répartie sur sa surface, pas multipliée par ses segments', () => {
  const led = { shape: 'lines', segments: [[[0, 0, 0], [2, 0, 0]], [[0, 0, 1], [2, 0, 1]]] };
  const rig = build(led, 16);
  applyLedState(rig, 6, new THREE.Color(1, 1, 1), 6);
  // Intensité équivalente 6 pour une surface totale : toutes les lumières égales,
  // dont la somme (luminance × surface) retombe sur 6.
  const total = rig.lights.reduce((s, l, i) => s + l.intensity * (l.width * l.height), 0);
  near(total, 6 * AREA_GAIN, 1e-6);
  assert.ok(rig.lights.every((l) => l.visible));
});

test('éteint, le profil n’éclaire pas et ses panneaux sont sombres', () => {
  const rig = build(defaultLed('rect', 0.1), 16);
  applyLedState(rig, 0, new THREE.Color(1, 1, 1), 6);
  assert.ok(rig.lights.every((l) => !l.visible));
  const lit = rig.materials[0].color.clone();
  applyLedState(rig, 6, new THREE.Color(1, 0.5, 0), 6);
  assert.ok(rig.materials[0].color.r > lit.r, 'allumé, le panneau s’éclaircit');
  near(rig.materials[0].color.r, 1);
});

test('l’éclat visible est borné par l’intensité pleine', () => {
  const rig = build(defaultLed('rect', 0.1), 16);
  applyLedState(rig, 60, new THREE.Color(1, 1, 1), 6);
  assert.ok(rig.materials[0].color.r <= 1);
  applyLedState(rig, 3, new THREE.Color(1, 1, 1), 0); // intensité pleine inconnue
  assert.ok(Number.isFinite(rig.materials[0].color.r));
});

test('la transition converge vers la cible puis s’arrête', () => {
  const rig = build(defaultLed('rect', 0.1), 16);
  const target = new THREE.Color(1, 0, 0);
  let moving = true;
  let steps = 0;
  while (moving && steps < 500) {
    moving = stepLedRig(rig, 5, target, 5, 0.3);
    steps++;
  }
  assert.ok(steps < 500, 'doit se stabiliser');
  near(rig.current.intensity, 5, 0.01);
  assert.equal(stepLedRig(rig, 5, target, 5, 0.3), false);
});

const spots = (points, style, left = 16) => buildLedRig({
  led: { shape: 'spots', points }, position: ORIGIN, unit: 0.1, style,
  areaBudget: budget(left), pointDistance: 8, pointDecay: 2,
});

test('chaque spot a sa lampe et sa pastille, sans consommer le budget des RectAreaLight', () => {
  const b = budget(2);
  const rig = buildLedRig({
    led: { shape: 'spots', points: [[0, 0, 0], [1, 0, 0], [2, 0, 0]] }, position: ORIGIN, unit: 0.1,
    style: 'spot', areaBudget: b, pointDistance: 8, pointDecay: 2,
  });
  assert.equal(rig.mode, 'spots');
  assert.equal(rig.lights.length, 3);
  assert.equal(rig.materials.length, 3);
  assert.equal(b.left, 2);
});

test('le style choisit la lampe : ampoule, cone large ou cone etroit', () => {
  assert.equal(spots([[0, 0, 0]], 'point').lights[0].isPointLight, true);
  const wide = spots([[0, 0, 0]], 'spot').lights[0];
  const narrow = spots([[0, 0, 0]], 'beam').lights[0];
  assert.equal(wide.isSpotLight, true);
  assert.ok(narrow.angle < wide.angle);
});

test('les spots visent le sens d’emission, vers le bas par defaut', () => {
  const l = spots([[1, 0, 2]], 'spot').lights[0];
  nearVec(l.target.position.clone().sub(l.position).normalize(), [0, -1, 0]);
});

test('chaque spot eclaire a pleine intensite, sans division par une surface', () => {
  const rig = spots([[0, 0, 0], [1, 0, 0], [2, 0, 0]], 'spot');
  applyLedState(rig, 5, new THREE.Color(1, 0.5, 0), 6);
  assert.ok(rig.lights.every((l) => l.intensity === 5 && l.visible));
  applyLedState(rig, 0, new THREE.Color(1, 1, 1), 6);
  assert.ok(rig.lights.every((l) => !l.visible));
});

test('le style fait partie de la signature des spots, pas de celle des rubans', () => {
  const sp = { shape: 'spots', points: [[0, 0, 0]] };
  assert.notEqual(ledSignature(sp, ORIGIN, undefined, 'spot'), ledSignature(sp, ORIGIN, undefined, 'beam'));
  const li = defaultLed('lines', 0.1);
  assert.equal(ledSignature(li, ORIGIN, undefined, 'spot'), ledSignature(li, ORIGIN, undefined, 'beam'));
});

test('le spot ajoute est decale du dernier, dans le plan d’emission', () => {
  const led = defaultLed('spots', 0.1);
  assert.equal(led.points.length, 1);
  const p = nextPoint(led, 0.1, [0, -1, 0]);
  near(p[1], 0);
  assert.ok(Math.hypot(...p) > 0);
});
