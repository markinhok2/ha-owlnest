import * as THREE from 'three';
import { openEntityPicker } from './entities/picker';
import type { EditableAnchor, LedShape, LedProfile, LightStyle } from './types';
import { defaultLed, emissionDir, ledFrame, ledPrimitives, nextPoint, nextSegment, rectSize } from './led';
import { t } from './i18n';

export type EditorTool = 'select' | 'add' | 'delete' | 'rotate' | 'add_panel';

/**
 * Instantané pour annuler/refaire.
 *
 * C'etait une liste blanche de huit champs, qui perdait donc `visibleIf`,
 * `precision`, `icon`, `color`, `tapAction`, `kind`, `actions` et `navViewId` a
 * chaque Ctrl+Z. On copie desormais l'ancre entiere : plus aucun champ a penser
 * a ajouter ici lorsqu'on en introduit un nouveau.
 */
type AnchorSnap = { key: string; anchor: EditableAnchor }[];

const AXIS_COLORS = { x: 0xFF3333, y: 0x33DD33, z: 0x3388FF };
const AXIS_DIRS: Record<string, THREE.Vector3> = {
  x: new THREE.Vector3(1, 0, 0),
  y: new THREE.Vector3(0, 1, 0),
  z: new THREE.Vector3(0, 0, 1),
};

/** Copie profonde d'une ancre : `position` et `led` sont des objets mutables. */
function cloneAnchor(a: EditableAnchor): EditableAnchor {
  return { ...a, position: a.position.clone(), led: a.led ? structuredClone(a.led) : undefined };
}

/** Une ancre a un sens d'emission si c'est un spot, un rayon ou un profil LED. */
function hasDirection(a: EditableAnchor | null | undefined): boolean {
  return !!a && (a.lightStyle === 'spot' || a.lightStyle === 'beam' || !!a.led);
}

/** Poignee d'un profil LED : une extremite de segment, ou un bord du rectangle. */
type LedHandle =
  | { kind: 'end'; index: number; end: 0 | 1 }
  | { kind: 'spot'; index: number }
  | { kind: 'rect'; which: 'w' | 'd' | 'c' };

export class AnchorEditor {
  onChanged: (() => void) | null = null;
  onToolChange: ((tool: EditorTool) => void) | null = null;
  onSelectionChange: ((key: string | null) => void) | null = null;
  onDragStart: ((type: 'grab' | 'rotate' | 'gizmo') => void) | null = null;
  onDragEnd: (() => void) | null = null;
  /** Called by undo() when the anchor undo stack is empty — allows EditPanel to chain card/rule undo. */
  onUndoFallback: (() => void) | null = null;
  /** Called by redo() when the anchor redo stack is empty — allows EditPanel to chain card/rule redo. */
  onRedoFallback: (() => void) | null = null;

  private _active = false;
  private _hass: import('./types').Hass | null = null;

  setHass(hass: import('./types').Hass | null) { this._hass = hass; }
  private _tool: EditorTool = 'select';
  private _raycaster = new THREE.Raycaster();
  private _anchors = new Map<string, EditableAnchor>();
  private _gizmoGroup: THREE.Group | null = null;
  private _selectedKey: string | null = null;
  private _dragAxis: string | null = null;
  private _dragPlane = new THREE.Plane();
  private _dragStart = new THREE.Vector3();
  private _markers = new Map<string, THREE.Mesh>();
  private _pendingPos: THREE.Vector3 | null = null;
  private _popup: HTMLDivElement | null = null;
  private _hoveredKey: string | null = null;
  private _undoStack: AnchorSnap[] = [];
  private _redoStack: AnchorSnap[] = [];
  private _markerRadius = 0.1;
  private _rotGizmoGroup: THREE.Group | null = null;
  private _rotAxis: 'x' | 'y' | 'z' | null = null;
  private _rotDragPlane = new THREE.Plane();
  private _rotDragStart = new THREE.Vector3();
  private _rotInitDir: [number, number, number] = [0, -1, 0];
  private _rotDirLine: THREE.Line | null = null;
  /** Profil LED au debut du geste de rotation : le profil tourne avec la direction. */
  private _rotInitLed: LedProfile | null = null;

  // Profils LED : contours de toutes les ancres, poignees de la selection
  private _ledGroup: THREE.Group | null = null;
  private _ledHandles: THREE.Mesh[] = [];
  private _ledDrag: LedHandle | null = null;
  /** Point de profil LED qui porte le gizmo a trois axes (un spot ou une extremite). */
  private _ledFocus: Extract<LedHandle, { kind: 'end' | 'spot' }> | null = null;
  private _pendingNormal: THREE.Vector3 | null = null;
  /** Normale de la surface ou chaque ancre a ete posee : sens d'emission par defaut d'un LED. */
  private _normals = new Map<string, THREE.Vector3>();

  // G-grab mode (Blender-style immediate move)
  private _grabMode = false;
  private _grabConstraint: 'x' | 'y' | 'z' | null = null;
  private _grabOrigin = new THREE.Vector3();
  private _grabPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
  private _grabOffset = new THREE.Vector3(); // offset for direct-drag (no teleport)

  // Direct drag (click-drag on marker without pressing G)
  private _directDragKey: string | null = null;
  private _directDragStartX = 0;
  private _directDragStartY = 0;

  private _scene: THREE.Scene;
  private _camera: THREE.PerspectiveCamera;
  private _canvas: HTMLCanvasElement;
  private _model: THREE.Object3D;
  private _overlayContainer: HTMLDivElement;

  constructor(
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    canvas: HTMLCanvasElement,
    model: THREE.Object3D,
    overlayContainer: HTMLDivElement,
  ) {
    this._scene = scene;
    this._camera = camera;
    this._canvas = canvas;
    this._model = model;
    this._overlayContainer = overlayContainer;
  }

  private _changed() {
    this._rebuildLedVisuals();
    this.onChanged?.();
  }

  private _selChanged(key: string | null) {
    this._rebuildLedVisuals();
    this.onSelectionChange?.(key);
  }

  get active() { return this._active; }
  get tool() { return this._tool; }
  get anchors() { return this._anchors; }
  get selectedKey() { return this._selectedKey; }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  activate(editable: Map<string, EditableAnchor>) {
    // Auto-scale markers relative to model size
    const box = new THREE.Box3().setFromObject(this._model);
    const size = box.getSize(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z);
    this._markerRadius = Math.max(0.03, maxDim * 0.012);

    this._active = true;
    this._tool = 'select';
    this._undoStack = [];
    this._redoStack = [];
    this._anchors = new Map(
      [...editable.entries()].map(([k, v]) => [k, cloneAnchor(v)]),
    );
    this._anchors.forEach((a, key) => this._addMarker(key, a.position, a.hidden));
    this._rebuildLedVisuals();
    this._canvas.addEventListener('pointerdown', this._onPointerDown, true);
    this._canvas.addEventListener('pointermove', this._onPointerMove, true);
    this._canvas.addEventListener('pointerup', this._onPointerUp, true);
    window.addEventListener('keydown', this._onKeyDown, true);
  }

  deactivate() {
    this._active = false;
    this._canvas.removeEventListener('pointerdown', this._onPointerDown, true);
    this._canvas.removeEventListener('pointermove', this._onPointerMove, true);
    this._canvas.removeEventListener('pointerup', this._onPointerUp, true);
    window.removeEventListener('keydown', this._onKeyDown, true);
    this._clearGizmo();
    this._clearRotGizmo();
    this._markers.forEach((m) => {
      this._scene.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    });
    this._markers.clear();
    this._clearLedVisuals();
    this._normals.clear();
    this._closePopup();
    this._selectedKey = null;
    this._hoveredKey = null;
    this._pendingPos = null;
    this._dragAxis = null;
    this._rotAxis = null;
    this._canvas.style.cursor = '';
  }

  setTool(tool: EditorTool) {
    this._tool = tool;
    // Crosshair in add/delete tool, restore on select/rotate
    this._canvas.style.cursor = (tool === 'add' || tool === 'delete') ? 'crosshair' : '';
    if (tool === 'add' || tool === 'delete') {
      this._clearGizmo();
      this._selectedKey = null;
      this._selChanged(null);
    }
    // Keep rot gizmo visible if selected anchor is spot/beam
    const selAnchor = this._selectedKey ? this._anchors.get(this._selectedKey) : null;
    const isDirectional = hasDirection(selAnchor);
    if (tool !== 'rotate' && !isDirectional) {
      this._clearRotGizmo();
    }
    if ((tool === 'rotate' || isDirectional) && this._selectedKey && selAnchor) {
      if (!this._rotGizmoGroup) this._buildRotGizmo(selAnchor.position, selAnchor.lightDirection);
    }
    this._closePopup();
    this.onToolChange?.(tool);
  }

  deleteSelected() {
    if (this._selectedKey) this._deleteAnchor(this._selectedKey);
  }

  duplicate() {
    if (!this._selectedKey) return;
    const src = this._anchors.get(this._selectedKey);
    if (!src) return;
    this._pushUndo();
    const key = `anchor_${Date.now()}_copy`;
    // Décalé de trois rayons de marqueur : le doublon doit être visiblement à
    // côté de l'original, quelle que soit l'unité du modèle. Une valeur fixe le
    // posait à trois millimètres sur un export en centimètres, donc dessus.
    const step = this._markerRadius * 3;
    const pos = src.position.clone().add(new THREE.Vector3(step, 0, step));
    const newAnchor: EditableAnchor = { ...cloneAnchor(src), position: pos };
    this._anchors.set(key, newAnchor);
    this._addMarker(key, pos, newAnchor.hidden);
    this._selectAnchor(key);
    this._changed();
  }

  /** Batch-update a property on every anchor (single undo entry). */
  updateAll(props: Partial<EditableAnchor>) {
    this._pushUndo();
    this._anchors.forEach((a, key) => {
      Object.assign(a, props);
      const marker = this._markers.get(key);
      if (marker && props.hidden !== undefined) {
        const mat = marker.material as THREE.MeshBasicMaterial;
        mat.opacity = a.hidden ? 0.25 : 1;
        mat.transparent = !!a.hidden;
        mat.color.setHex(a.hidden ? 0x888888 : (key === this._selectedKey ? 0xFFFFFF : 0xFFDD00));
      }
    });
    this._changed();
  }

  selectAnchor(key: string) { this._selectAnchor(key); }

  updateAnchor(key: string, props: Partial<EditableAnchor>) {
    const anchor = this._anchors.get(key);
    if (!anchor) return;
    this._pushUndo();
    Object.assign(anchor, props);
    // Sync rotation gizmo when lightStyle changes on selected anchor
    if (('lightStyle' in props || 'led' in props) && key === this._selectedKey) {
      const isDirectional = hasDirection(anchor);
      if (isDirectional) {
        this._clearRotGizmo();
        this._buildRotGizmo(anchor.position, anchor.lightDirection);
      } else {
        this._clearRotGizmo();
      }
    }
    const marker = this._markers.get(key);
    if (marker) {
      const mat = marker.material as THREE.MeshBasicMaterial;
      mat.opacity = anchor.hidden ? 0.25 : (key === this._selectedKey ? 1 : 1);
      mat.transparent = !!anchor.hidden;
      mat.color.setHex(anchor.hidden ? 0x888888 : (key === this._selectedKey ? 0xFFFFFF : 0xFFDD00));
    }
    this._changed();
  }

  // ── Undo / Redo ─────────────────────────────────────────────────────────

  private _snap(): AnchorSnap {
    return [...this._anchors.entries()].map(([key, a]) => ({
      key,
      // Vector3 n'est pas clonable par le spread : sa position doit l'etre a part.
      anchor: cloneAnchor(a),
    }));
  }

  private _pushUndo() {
    this._undoStack.push(this._snap());
    this._redoStack = [];
  }

  private _restore(snap: AnchorSnap, prevSelectedKey?: string) {
    this._clearGizmo();
    this._selectedKey = null;
    this._selChanged(null);
    this._markers.forEach((m) => {
      this._scene.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    });
    this._markers.clear();
    this._anchors.clear();

    for (const s of snap) {
      const restored: EditableAnchor = cloneAnchor(s.anchor);
      this._anchors.set(s.key, restored);
      this._addMarker(s.key, restored.position, restored.hidden);
    }
    // Re-select the previously selected anchor if it still exists
    const keyToReselect = prevSelectedKey && this._anchors.has(prevSelectedKey) ? prevSelectedKey : null;
    if (keyToReselect) {
      this._selectAnchor(keyToReselect);
    }
    this._selChanged(this._selectedKey);
    this._changed();
  }

  undo() {
    if (!this._undoStack.length) { this.onUndoFallback?.(); return; }
    const prevKey = this._selectedKey;
    this._redoStack.push(this._snap());
    this._restore(this._undoStack.pop()!, prevKey ?? undefined);
  }

  redo() {
    if (!this._redoStack.length) { this.onRedoFallback?.(); return; }
    const prevKey = this._selectedKey;
    this._undoStack.push(this._snap());
    this._restore(this._redoStack.pop()!, prevKey ?? undefined);
  }

  // ── Markers ─────────────────────────────────────────────────────────────

  private _addMarker(key: string, pos: THREE.Vector3, hidden = false) {
    const geo = new THREE.SphereGeometry(this._markerRadius, 14, 10);
    const mat = new THREE.MeshBasicMaterial({
      color: hidden ? 0x555555 : 0xFFDD00,
      depthTest: false,
      transparent: true,
      opacity: hidden ? 0.2 : 1,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(pos);
    mesh.userData.anchorKey = key;
    mesh.userData.hidden = hidden;
    mesh.renderOrder = 999;
    this._scene.add(mesh);
    this._markers.set(key, mesh);
  }

  private _deleteAnchor(key: string) {
    this._pushUndo();
    this._anchors.delete(key);
    const m = this._markers.get(key);
    if (m) {
      this._scene.remove(m);
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
      this._markers.delete(key);
    }
    if (this._selectedKey === key) {
      this._clearGizmo();
      this._selectedKey = null;
      this._selChanged(null);
    }
    this._changed();
  }

  // ── Gizmo ──────────────────────────────────────────────────────────────

  private _selectAnchor(key: string) {
    this._selectedKey = key;
    this._ledFocus = null;
    this._clearGizmo();
    this._clearRotGizmo();
    const anchor = this._anchors.get(key);
    if (anchor) {
      if (this._tool === 'select') {
        this._buildGizmo(anchor.position);
      }
      this._markers.forEach((m, k) => {
        const a = this._anchors.get(k);
        const isHidden = a?.hidden ?? false;
        (m.material as THREE.MeshBasicMaterial).color.setHex(
          k === key ? 0xFFFFFF : (isHidden ? 0x888888 : 0xFFDD00)
        );
      });
      // Show rotation gizmo for directional lights regardless of active tool
      const isDirectional = hasDirection(anchor);
      if (this._tool === 'rotate' || isDirectional) {
        this._buildRotGizmo(anchor.position, anchor.lightDirection);
      }
    }
    this._selChanged(key);
  }

  private _buildGizmo(pos: THREE.Vector3) {
    this._gizmoGroup = new THREE.Group();
    this._gizmoGroup.position.copy(pos);

    /**
     * Toutes les cotes du gizmo sont exprimées en rayons de marqueur.
     *
     * Elles étaient écrites en dur, pour un modèle en mètres : sur un export
     * Sweet Home 3D de 618 unités, la flèche mesurait six millimètres et sa
     * zone cliquable un millimètre. Invisible, et impossible à saisir.
     *
     * Le marqueur d'ancre et le gizmo de rotation suivaient déjà l'envergure ;
     * seul celui-ci avait été oublié.
     */
    const R = this._markerRadius;

    (['x', 'y', 'z'] as const).forEach((axis) => {
      const color = AXIS_COLORS[axis];

      const shaftGeo = new THREE.CylinderGeometry(0.3 * R, 0.3 * R, 6 * R, 8);
      const shaftMat = new THREE.MeshBasicMaterial({ color, depthTest: false });
      const shaft = new THREE.Mesh(shaftGeo, shaftMat);
      shaft.position.y = 3 * R;
      shaft.renderOrder = 1000;
      shaft.userData.gizmoAxis = axis;

      const coneGeo = new THREE.ConeGeometry(0.8 * R, 1.8 * R, 8);
      const coneMat = new THREE.MeshBasicMaterial({ color, depthTest: false });
      const cone = new THREE.Mesh(coneGeo, coneMat);
      cone.position.y = 6.9 * R;
      cone.renderOrder = 1000;
      cone.userData.gizmoAxis = axis;

      // La zone de saisie est volontairement plus large que la flèche : c'est
      // elle qui rend le gizmo utilisable au doigt.
      const hitGeo = new THREE.CylinderGeometry(1.2 * R, 1.2 * R, 9 * R, 8);
      const hitMat = new THREE.MeshBasicMaterial({ visible: false, depthTest: false });
      const hit = new THREE.Mesh(hitGeo, hitMat);
      hit.position.y = 4.5 * R;
      hit.renderOrder = 1000;
      hit.userData.gizmoAxis = axis;

      const group = new THREE.Group();
      group.add(shaft, cone, hit);
      group.userData.gizmoAxis = axis;
      if (axis === 'x') group.rotation.z = -Math.PI / 2;
      else if (axis === 'z') group.rotation.x = Math.PI / 2;

      this._gizmoGroup!.add(group);
    });

    this._scene.add(this._gizmoGroup);
  }

  private _clearGizmo() {
    if (!this._gizmoGroup) return;
    this._gizmoGroup.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        (o.material as THREE.Material).dispose();
      }
    });
    this._scene.remove(this._gizmoGroup);
    this._gizmoGroup = null;
    this._markers.forEach((m, k) => {
      const a = this._anchors.get(k);
      const isHidden = a?.hidden ?? false;
      (m.material as THREE.MeshBasicMaterial).color.setHex(isHidden ? 0x888888 : 0xFFDD00);
    });
  }

  // ── Rotation gizmo ─────────────────────────────────────────────────────

  /** Build or rebuild the rotation rings gizmo at the given position. */
  private _buildRotGizmo(pos: THREE.Vector3, dir?: [number, number, number]) {
    this._clearRotGizmo();
    const anchor = this._selectedKey ? this._anchors.get(this._selectedKey) : null;
    if (!hasDirection(anchor)) return;

    const group = new THREE.Group();
    group.position.copy(pos);
    const R = this._markerRadius * 5;
    const TUBE = R * 0.045;

    const ringDefs: { axis: 'x' | 'y' | 'z'; color: number; rx: number; ry: number; rz: number }[] = [
      { axis: 'x', color: 0xFF4444, rx: 0, ry: Math.PI / 2, rz: 0 },
      { axis: 'y', color: 0x44DD44, rx: Math.PI / 2, ry: 0, rz: 0 },
      { axis: 'z', color: 0x4488FF, rx: 0, ry: 0, rz: 0 },
    ];

    for (const { axis, color, rx, ry, rz } of ringDefs) {
      // Visible ring
      const geo = new THREE.TorusGeometry(R, TUBE, 8, 64);
      const mat = new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.85 });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.rotation.set(rx, ry, rz);
      mesh.renderOrder = 999;
      mesh.userData.rotAxis = axis;
      group.add(mesh);

      // Invisible thick ring for easier picking
      const pickGeo = new THREE.TorusGeometry(R, TUBE * 5, 4, 64);
      const pickMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthTest: false });
      const pickMesh = new THREE.Mesh(pickGeo, pickMat);
      pickMesh.rotation.set(rx, ry, rz);
      pickMesh.renderOrder = 998;
      pickMesh.userData.rotAxis = axis;
      group.add(pickMesh);
    }

    // Direction indicator line
    const d = dir ?? [0, -1, 0];
    const lineGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(d[0] * R * 1.3, d[1] * R * 1.3, d[2] * R * 1.3),
    ]);
    const lineMat = new THREE.LineBasicMaterial({ color: 0xFFFFFF, depthTest: false });
    this._rotDirLine = new THREE.Line(lineGeo, lineMat);
    this._rotDirLine.renderOrder = 1000;
    group.add(this._rotDirLine);

    this._scene.add(group);
    this._rotGizmoGroup = group;
  }

  private _clearRotGizmo() {
    if (this._rotGizmoGroup) {
      this._scene.remove(this._rotGizmoGroup);
      this._rotGizmoGroup.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.geometry.dispose();
          (obj.material as THREE.Material).dispose();
        }
        if (obj instanceof THREE.Line) {
          obj.geometry.dispose();
          (obj.material as THREE.Material).dispose();
        }
      });
      this._rotGizmoGroup = null;
      this._rotDirLine = null;
    }
  }

  /** Update just the direction indicator line inside the rotation gizmo. */
  private _updateRotGizmoDir(dir: [number, number, number]) {
    if (!this._rotDirLine || !this._rotGizmoGroup) return;
    const R = this._markerRadius * 5;
    const positions = this._rotDirLine.geometry.attributes.position as THREE.BufferAttribute;
    positions.setXYZ(1, dir[0] * R * 1.3, dir[1] * R * 1.3, dir[2] * R * 1.3);
    positions.needsUpdate = true;
  }

  // ── Profils LED ─────────────────────────────────────────────────────────

  /** Cree, remplace ou retire le profil LED d'une ancre (`null` : retour au point). */
  setLedShape(key: string, shape: LedShape | null) {
    const a = this._anchors.get(key);
    if (!a) return;
    if (!shape) { this.updateAnchor(key, { led: undefined }); return; }
    // Une surface a ete visee a la pose : le profil emet vers la piece. Sur une
    // surface horizontale on garde « vers le bas » : la camera de l'editeur voit
    // le plafond par le dessus, donc sa normale pointerait vers le haut.
    const normal = this._normals.get(key);
    const wall = normal && Math.abs(normal.y) < 0.7;
    const direction = a.lightDirection ?? (wall ? [normal.x, normal.y, normal.z] as [number, number, number] : undefined);
    // Des spots sans cone ne seraient que des ampoules : on propose le cone par defaut.
    const style = shape === 'spots' && (a.lightStyle ?? 'point') === 'point' ? 'spot' : a.lightStyle;
    this.updateAnchor(key, { led: defaultLed(shape, this._markerRadius, direction), lightDirection: direction, lightStyle: style });
  }

  addLedPoint(key: string) {
    const a = this._anchors.get(key);
    if (!a?.led || a.led.shape !== 'spots') return;
    const led = structuredClone(a.led);
    led.points = [...(led.points ?? []), nextPoint(led, this._markerRadius, a.lightDirection)];
    this.updateAnchor(key, { led });
  }

  /**
   * Aligne tous les spots sur un axe : leur coordonnee prend celle du spot
   * selectionne (le premier a defaut), ce qui les range sur un meme plan.
   */
  alignLedPoints(key: string, axis: 'x' | 'y' | 'z') {
    const a = this._anchors.get(key);
    const pts = a?.led?.points;
    if (!a?.led || !pts || pts.length < 2) return;
    const i = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
    const ref = pts[this._ledFocus?.kind === 'spot' && pts[this._ledFocus.index] ? this._ledFocus.index : 0][i];
    const led = structuredClone(a.led);
    led.points!.forEach((p) => { p[i] = ref; });
    this.updateAnchor(key, { led });
    this._recenterLed(key);
  }

  removeLedPoint(key: string, index: number) {
    const a = this._anchors.get(key);
    if (!a?.led?.points || a.led.points.length <= 1) return;
    const led = structuredClone(a.led);
    led.points!.splice(index, 1);
    this.updateAnchor(key, { led });
  }

  addLedSegment(key: string) {
    const a = this._anchors.get(key);
    if (!a?.led || a.led.shape !== 'lines') return;
    const led = structuredClone(a.led);
    led.segments = [...(led.segments ?? []), nextSegment(led, this._markerRadius, a.lightDirection)];
    this.updateAnchor(key, { led });
  }

  removeLedSegment(key: string, index: number) {
    const a = this._anchors.get(key);
    if (!a?.led?.segments || a.led.segments.length <= 1) return;
    const led = structuredClone(a.led);
    led.segments!.splice(index, 1);
    this.updateAnchor(key, { led });
  }

  updateLed(key: string, patch: Partial<LedProfile>) {
    const a = this._anchors.get(key);
    if (!a?.led) return;
    this.updateAnchor(key, { led: { ...structuredClone(a.led), ...patch } });
  }

  private _clearLedVisuals() {
    if (!this._ledGroup) return;
    this._ledGroup.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
      if (m.material) (m.material as THREE.Material).dispose();
    });
    this._scene.remove(this._ledGroup);
    this._ledGroup = null;
    this._ledHandles = [];
  }

  /**
   * Contour de chaque profil LED, et poignees de celui qui est selectionne.
   * Reconstruit en bloc : quelques lignes et spheres, rien a economiser.
   */
  private _rebuildLedVisuals() {
    this._clearLedVisuals();
    if (!this._active) return;
    if (this._ledFocus) {
      const sel = this._selectedKey ? this._anchors.get(this._selectedKey) : null;
      // Annuler, supprimer un spot ou changer de forme peut avoir fait disparaitre le point.
      const at = sel ? this._ledPointPos(sel, this._ledFocus) : null;
      if (!at) this._setLedFocus(null);
      // Le gizmo suit le point, que la poignee, le gizmo ou le recentrage l'ait deplace.
      else this._gizmoGroup?.position.copy(at);
    }
    const R = this._markerRadius;
    const group = new THREE.Group();

    this._anchors.forEach((a, key) => {
      if (!a.led) return;
      const selected = key === this._selectedKey;
      const prims = ledPrimitives(a.led, a.position, a.lightDirection, R);
      const lineMat = new THREE.LineBasicMaterial({
        color: selected ? 0x7DD3FC : 0xFFDD00,
        depthTest: false, transparent: true, opacity: selected ? 1 : 0.55,
      });

      if (a.led.shape === 'rect') {
        // Contour exterieur du cadre ; les quatre rubans sont dessines par le rig.
        const [w, d] = rectSize(a.led, R);
        const { u, v } = ledFrame(emissionDir(a.lightDirection), a.led.spin);
        const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([x, y]) =>
          a.position.clone().addScaledVector(u, x * w / 2).addScaledVector(v, y * d / 2));
        const loop = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), lineMat);
        loop.renderOrder = 997;
        group.add(loop);
      } else {
        for (const p of prims) {
          const pts = [-p.width / 2, p.width / 2].map((x) => new THREE.Vector3(x, 0, 0).applyQuaternion(p.quaternion).add(p.center));
          const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lineMat);
          line.renderOrder = 997;
          group.add(line);
        }
      }

      if (!selected || this._tool === 'add' || this._tool === 'delete') return;

      const handle = (pos: THREE.Vector3, info: LedHandle, color: number) => {
        const m = new THREE.Mesh(
          new THREE.SphereGeometry(R * 0.7, 12, 8),
          new THREE.MeshBasicMaterial({ color: this._isLedFocus(info) ? 0xFFFFFF : color, depthTest: false }),
        );
        m.position.copy(pos);
        m.renderOrder = 1001;
        m.userData.ledHandle = info;
        group.add(m);
        this._ledHandles.push(m);
      };

      if (a.led.shape === 'spots') {
        (a.led.points ?? []).forEach((p, index) => {
          handle(a.position.clone().add(new THREE.Vector3(...p)), { kind: 'spot', index }, 0xFBBF24);
        });
      } else if (a.led.shape === 'lines') {
        (a.led.segments ?? []).forEach(([p0, p1], index) => {
          handle(a.position.clone().add(new THREE.Vector3(...p0)), { kind: 'end', index, end: 0 }, 0x7DD3FC);
          handle(a.position.clone().add(new THREE.Vector3(...p1)), { kind: 'end', index, end: 1 }, 0x7DD3FC);
        });
      } else {
        const [w, d] = a.led.size ?? [R * 14, R * 14];
        const { u, v } = ledFrame(emissionDir(a.lightDirection), a.led.spin);
        handle(a.position.clone().addScaledVector(u, w / 2), { kind: 'rect', which: 'w' }, 0xFF6B6B);
        handle(a.position.clone().addScaledVector(v, d / 2), { kind: 'rect', which: 'd' }, 0x6BFF8F);
        handle(a.position.clone().addScaledVector(u, w / 2).addScaledVector(v, d / 2), { kind: 'rect', which: 'c' }, 0xFFFFFF);
      }
    });

    this._scene.add(group);
    this._ledGroup = group;
  }

  /** Position monde d'un point de profil, ou null s'il n'existe plus. */
  private _ledPointPos(a: EditableAnchor, h: Extract<LedHandle, { kind: 'end' | 'spot' }>): THREE.Vector3 | null {
    const rel = h.kind === 'spot' ? a.led?.points?.[h.index] : a.led?.segments?.[h.index]?.[h.end];
    return rel ? a.position.clone().add(new THREE.Vector3(...rel)) : null;
  }

  /**
   * Donne le gizmo a trois axes a un point du profil (`null` : il revient a
   * l'ancre entiere). Le gizmo de l'ancre deplace tout le profil ; celui-ci
   * deplace un seul spot ou une seule extremite.
   */
  private _setLedFocus(h: Extract<LedHandle, { kind: 'end' | 'spot' }> | null) {
    this._ledFocus = h;
    this._clearGizmo();
    const a = this._selectedKey ? this._anchors.get(this._selectedKey) : null;
    if (!a) return;
    const pos = h ? this._ledPointPos(a, h) : a.position;
    if (pos && this._tool === 'select') this._buildGizmo(pos);
    else this._ledFocus = null;
    // _clearGizmo recolore les marqueurs : on remet la selection en evidence.
    if (this._selectedKey) (this._markers.get(this._selectedKey)?.material as THREE.MeshBasicMaterial | undefined)?.color.setHex(0xFFFFFF);
  }

  private _isLedFocus(h: LedHandle): boolean {
    const f = this._ledFocus;
    return !!f && f.kind === h.kind && f.index === (h as { index: number }).index
      && (f.kind !== 'end' || f.end === (h as { end: 0 | 1 }).end);
  }

  /** Selectionne un spot depuis le panneau. */
  focusLedPoint(key: string, index: number) {
    if (key !== this._selectedKey) return;
    this._setLedFocus({ kind: 'spot', index });
  }

  private _startLedDrag(e: PointerEvent, handle: LedHandle) {
    if (handle.kind === 'end' || handle.kind === 'spot') this._setLedFocus(handle);
    this._pushUndo();
    this._ledDrag = handle;
    this._canvas.setPointerCapture(e.pointerId);
    this.onDragStart?.('gizmo');
  }

  /**
   * Deplace une poignee. Par defaut elle colle a la surface du modele sous le
   * curseur, ce qui pose un ruban sur un plafond ou un mur sans effort ; Alt la
   * garde sur son plan horizontal, Maj sur un plan vertical face a la camera,
   * pour atteindre les trois axes sans surface a viser.
   */
  private _moveLedHandle(e: PointerEvent) {
    const key = this._selectedKey;
    const handle = this._ledDrag;
    const a = key ? this._anchors.get(key) : null;
    if (!handle || !a?.led) return;

    this._raycaster.setFromCamera(this._ndc(e), this._camera);

    if (handle.kind === 'end' || handle.kind === 'spot') {
      const seg = handle.kind === 'end' ? a.led.segments?.[handle.index] : undefined;
      const pt = handle.kind === 'spot' ? a.led.points?.[handle.index] : undefined;
      if (!seg && !pt) return;
      const current = a.position.clone().add(new THREE.Vector3(...(handle.kind === 'end' ? seg![handle.end] : pt!)));
      const target = new THREE.Vector3();
      let found = false;

      if (!e.altKey && !e.shiftKey) {
        const hit = this._raycaster.intersectObject(this._model, true)[0];
        if (hit) {
          target.copy(hit.point);
          if (hit.face) {
            const n = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
            if (n.dot(this._raycaster.ray.direction) > 0) n.negate();
            target.addScaledVector(n, this._markerRadius * 0.15);
          }
          found = true;
        }
      }
      if (!found) {
        const plane = new THREE.Plane();
        if (e.shiftKey) {
          const dir = new THREE.Vector3();
          this._camera.getWorldDirection(dir);
          dir.y = 0;
          if (dir.lengthSq() < 1e-4) dir.set(1, 0, 0);
          plane.setFromNormalAndCoplanarPoint(dir.normalize(), current);
        } else {
          plane.set(new THREE.Vector3(0, 1, 0), -current.y);
        }
        if (!this._raycaster.ray.intersectPlane(plane, target)) return;
      }

      const rel: [number, number, number] = [target.x - a.position.x, target.y - a.position.y, target.z - a.position.z];
      if (handle.kind === 'end') seg![handle.end] = rel;
      else a.led.points![handle.index] = rel;
    } else {
      const dir = emissionDir(a.lightDirection);
      const { u, v } = ledFrame(dir, a.led.spin);
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(dir, a.position);
      const hit = new THREE.Vector3();
      if (!this._raycaster.ray.intersectPlane(plane, hit)) return;
      const local = hit.sub(a.position);
      const min = this._markerRadius * 0.4;
      const [w0, d0] = a.led.size ?? [this._markerRadius * 14, this._markerRadius * 14];
      a.led.size = [
        handle.which === 'd' ? w0 : Math.max(min, 2 * Math.abs(local.dot(u))),
        handle.which === 'w' ? d0 : Math.max(min, 2 * Math.abs(local.dot(v))),
      ];
    }
    this._changed();
  }

  /**
   * Recentre l'ancre sur son profil apres un deplacement de poignee : la pastille
   * et le gizmo suivent alors le profil au lieu de rester a l'endroit de la pose.
   */
  private _recenterLed(key: string) {
    const a = this._anchors.get(key);
    const segs = a?.led?.shape === 'lines' ? a.led.segments : undefined;
    const pts = a?.led?.shape === 'spots' ? a.led.points : undefined;
    if (!a || !(segs?.length || pts?.length)) return;
    const c = new THREE.Vector3();
    segs?.forEach(([p, q]) => c.add(new THREE.Vector3(...p)).add(new THREE.Vector3(...q)));
    pts?.forEach((p) => c.add(new THREE.Vector3(...p)));
    c.divideScalar(segs ? segs.length * 2 : pts!.length);
    if (c.lengthSq() < 1e-10) return;
    segs?.forEach((seg) => {
      seg[0] = [seg[0][0] - c.x, seg[0][1] - c.y, seg[0][2] - c.z];
      seg[1] = [seg[1][0] - c.x, seg[1][1] - c.y, seg[1][2] - c.z];
    });
    pts?.forEach((p, i) => { pts[i] = [p[0] - c.x, p[1] - c.y, p[2] - c.z]; });
    a.position.add(c);
    this._markers.get(key)?.position.copy(a.position);
    if (!this._ledFocus) this._gizmoGroup?.position.copy(a.position);
    this._rotGizmoGroup?.position.copy(a.position);
    this._changed();
  }

  // ── NDC helper ─────────────────────────────────────────────────────────

  private _ndc(e: PointerEvent): THREE.Vector2 {
    const rect = this._canvas.getBoundingClientRect();
    return new THREE.Vector2(
      (e.clientX - rect.left) / rect.width * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
  }

  private _startDrag(e: PointerEvent, axis: string) {
    this._pushUndo();
    this._dragAxis = axis;
    this._canvas.setPointerCapture(e.pointerId);
    this.onDragStart?.('gizmo');
    const pos = this._gizmoGroup!.position.clone();
    const axisDir = AXIS_DIRS[axis].clone();
    const toCam = new THREE.Vector3().subVectors(pos, this._camera.position).normalize();
    const perp = new THREE.Vector3().crossVectors(axisDir, toCam);
    const normal = new THREE.Vector3().crossVectors(axisDir, perp).normalize();
    this._dragPlane.setFromNormalAndCoplanarPoint(normal, pos);
    this._raycaster.ray.intersectPlane(this._dragPlane, this._dragStart);
  }

  private _startRotDrag(e: PointerEvent, axis: 'x' | 'y' | 'z') {
    this._pushUndo();
    this._rotAxis = axis;
    this._canvas.setPointerCapture(e.pointerId);
    this.onDragStart?.('rotate');

    const center = this._rotGizmoGroup!.position;
    const axisVec = axis === 'x' ? new THREE.Vector3(1, 0, 0)
      : axis === 'y' ? new THREE.Vector3(0, 1, 0)
      : new THREE.Vector3(0, 0, 1);
    this._rotDragPlane.setFromNormalAndCoplanarPoint(axisVec, center);

    const ndc = this._ndc(e);
    this._raycaster.setFromCamera(ndc, this._camera);
    const hit = new THREE.Vector3();
    this._raycaster.ray.intersectPlane(this._rotDragPlane, hit);
    this._rotDragStart.subVectors(hit, center).normalize();

    const anchor = this._selectedKey ? this._anchors.get(this._selectedKey) : null;
    this._rotInitDir = anchor?.lightDirection ? [...anchor.lightDirection] as [number, number, number] : [0, -1, 0];
    this._rotInitLed = anchor?.led ? structuredClone(anchor.led) : null;
  }

  // ── Entity picker popup ─────────────────────────────────────────────────

  private _showEntityPicker() {
    this._closePopup();
    if (!this._hass || !this._pendingPos) return;

    // Les entités déjà posées sont signalées : c'est la question la plus
    // fréquente au moment de placer une ancre de plus.
    const placed = new Set<string>();
    this._anchors.forEach((a) => placed.add(a.entity));

    /** Crée l'ancre à la position en attente et la sélectionne. */
    const create = (props: Partial<EditableAnchor> & { entity: string; label: string }) => {
      this._popup = null;
      if (!this._pendingPos) return;
      const key = `anchor_${Date.now()}_${props.entity || props.kind || 'x'}`;
      const anchor: EditableAnchor = {
        position: this._pendingPos.clone(),
        ...props,
      };
      this._pushUndo();
      this._anchors.set(key, anchor);
      if (this._pendingNormal) this._normals.set(key, this._pendingNormal.clone());
      this._addMarker(key, anchor.position);
      this.setTool('select');
      this._selectAnchor(key);
      this._pendingPos = null;
      this._changed();
      this.onToolChange?.('select');
    };

    const close = openEntityPicker({
      container: this._overlayContainer,
      hass: this._hass,
      placed,
      onCancel: () => { this._popup = null; this._pendingPos = null; },
      // Ancre sans entité : créée en étiquette, sa nature se change ensuite dans
      // ses propriétés.
      onPickNone: () => create({ entity: '', label: t('anchorLabelDefault'), kind: 'label' }),
      onPick: (entity, label) => create({
        entity,
        label: label || entity.split('.')[1] || entity,
      }),
    });

    // _closePopup() doit pouvoir refermer le sélecteur comme n'importe quel
    // popup : on lui présente un objet porteur de remove().
    this._popup = { remove: close } as unknown as HTMLDivElement;
  }

  // ── Popup helpers ───────────────────────────────────────────────────────

  private _closePopup() {
    this._popup?.remove();
    this._popup = null;
  }


  private _startGrab(offset = new THREE.Vector3()) {
    if (!this._selectedKey) return;
    const anchor = this._anchors.get(this._selectedKey);
    if (!anchor) return;
    this._grabOrigin.copy(anchor.position);
    this._grabConstraint = null;
    this._grabMode = true;
    this._grabOffset.copy(offset);
    this._grabPlane.set(new THREE.Vector3(0, 1, 0), -anchor.position.y);
    this._canvas.style.cursor = 'crosshair';
    this.onDragStart?.('grab');
  }

  private _confirmGrab() {
    this._grabMode = false;
    this._grabConstraint = null;
    this._canvas.style.cursor = '';
    this.onDragEnd?.();
  }

  private _cancelGrab() {
    if (this._grabMode && this._selectedKey) {
      const anchor = this._anchors.get(this._selectedKey);
      if (anchor) {
        anchor.position.copy(this._grabOrigin);
        this._gizmoGroup?.position.copy(this._grabOrigin);
        this._rotGizmoGroup?.position.copy(this._grabOrigin);
        this._markers.get(this._selectedKey)?.position.copy(this._grabOrigin);
      }
      this._changed();
    }
    this._grabMode = false;
    this._grabConstraint = null;
    this._canvas.style.cursor = '';
    this.onDragEnd?.();
  }

  private _showContextMenu(e: PointerEvent, key: string) {
    this._closePopup();
    const anchor = this._anchors.get(key);
    if (!anchor) return;

    const containerRect = this._overlayContainer.getBoundingClientRect();
    const menu = document.createElement('div');
    menu.style.cssText = [
      `left:${e.clientX - containerRect.left}px`,
      `top:${e.clientY - containerRect.top}px`,
      'position:absolute', 'background:#131820',
      'border:1px solid rgba(255,255,255,0.12)', 'border-radius:9px',
      'padding:4px 0', 'min-width:168px', 'z-index:2000',
      'box-shadow:0 10px 32px rgba(0,0,0,0.75)', 'font-size:12px',
      'font-family:inherit', 'user-select:none',
    ].join(';');

    const item = (label: string, shortcut: string, action: () => void, danger = false) => {
      const el = document.createElement('div');
      el.style.cssText = [
        'padding:7px 14px', 'cursor:pointer', 'display:flex',
        'justify-content:space-between', 'align-items:center', 'gap:18px',
        `color:${danger ? '#f87171' : '#e2e8f0'}`, 'border-radius:5px', 'margin:1px 3px',
      ].join(';');
      el.innerHTML = `<span>${label}</span><span style="color:rgba(255,255,255,0.28);font-size:10px;letter-spacing:.03em">${shortcut}</span>`;
      el.addEventListener('mouseenter', () => { el.style.background = 'rgba(255,255,255,0.08)'; });
      el.addEventListener('mouseleave', () => { el.style.background = ''; });
      el.addEventListener('mousedown', (ev) => { ev.preventDefault(); this._closePopup(); action(); });
      return el;
    };
    const sep = () => { const s = document.createElement('div'); s.style.cssText = 'height:1px;background:rgba(255,255,255,0.07);margin:3px 0;'; return s; };

    menu.appendChild(item(t('hintGrab'), 'G', () => { this.setTool('select'); this._selectAnchor(key); this._startGrab(); }));
    if (hasDirection(anchor)) {
      menu.appendChild(item(t('hintRotate'), 'R', () => { this.setTool('rotate'); this._selectAnchor(key); }));
    }
    menu.appendChild(sep());
    menu.appendChild(item(t('hintDup'), 'Ctrl+D', () => { this._selectAnchor(key); this.duplicate(); }));
    menu.appendChild(item(anchor.hidden ? t('hintShow') : t('hintHide'), 'H', () => this.updateAnchor(key, { hidden: !anchor.hidden })));
    menu.appendChild(sep());
    menu.appendChild(item(t('hintDelete'), 'X', () => this._deleteAnchor(key), true));

    this._popup = menu;
    this._overlayContainer.appendChild(menu);
    const close = (ev: MouseEvent) => {
      if (!menu.contains(ev.target as Node)) { this._closePopup(); document.removeEventListener('mousedown', close); }
    };
    setTimeout(() => document.addEventListener('mousedown', close), 0);
  }

  // ── Event handlers ──────────────────────────────────────────────────────

  private _onKeyDown = (e: KeyboardEvent) => {
    if (!this._active) return;

    // Block shortcuts while typing in inputs.
    // Must traverse shadow roots — document.activeElement only points to the host element.
    const getDeepActive = (): Element | null => {
      let el: Element | null = document.activeElement;
      while (el?.shadowRoot) el = el.shadowRoot.activeElement;
      return el;
    };
    const active = getDeepActive();
    const inInput = active instanceof HTMLInputElement
      || active instanceof HTMLTextAreaElement
      || (active instanceof HTMLElement && active.isContentEditable);
    if (inInput) {
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); (active as HTMLElement).blur(); }
      e.stopPropagation();
      return;
    }

    // Grab mode: only axis-constraint, confirm, cancel
    if (this._grabMode) {
      e.preventDefault(); e.stopImmediatePropagation();
      switch (e.key) {
        case 'x': case 'X': this._grabConstraint = this._grabConstraint === 'x' ? null : 'x'; break;
        case 'y': case 'Y': this._grabConstraint = this._grabConstraint === 'y' ? null : 'y'; break;
        case 'z': case 'Z': this._grabConstraint = this._grabConstraint === 'z' ? null : 'z'; break;
        case 'Escape': case 'Mouse2': this._cancelGrab(); break;
        case 'Enter': this._confirmGrab(); break;
      }
      return;
    }

    if (this._popup) { if (e.key === 'Escape') { e.preventDefault(); this._closePopup(); } return; }

    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.key === 'z') { e.preventDefault(); e.stopImmediatePropagation(); this.undo(); return; }
    if (ctrl && (e.key === 'y' || (e.shiftKey && e.key === 'z'))) { e.preventDefault(); e.stopImmediatePropagation(); this.redo(); return; }
    if (ctrl && e.key === 'd') { e.preventDefault(); e.stopImmediatePropagation(); this.duplicate(); return; }
    if (ctrl) return;

    switch (e.key) {
      case 'Delete': case 'Backspace': case 'x': case 'X':
        if (this._selectedKey) { e.preventDefault(); this._deleteAnchor(this._selectedKey); }
        break;
      case 'g': case 'G': e.preventDefault(); this._startGrab(); break;
      case 'h': case 'H':
        if (this._selectedKey) {
          const a = this._anchors.get(this._selectedKey);
          if (a) this.updateAnchor(this._selectedKey, { hidden: !a.hidden });
        }
        break;
      case 'Escape':
        e.preventDefault();
        if (this._selectedKey) { this._clearGizmo(); this._clearRotGizmo(); this._selectedKey = null; this._selChanged(null); }
        else this.setTool('select');
        break;
      case 's': case 'S': this.setTool('select'); break;
      case 'r': case 'R': this.setTool('rotate'); break;
      case 'a': case 'A': this.setTool('add'); break;
    }
  };

  private _onPointerDown = (e: PointerEvent) => {
    if (!this._active) return;

    // Confirm/cancel grab on any click
    if (this._grabMode) {
      e.stopImmediatePropagation();
      if (e.button === 0) this._confirmGrab();
      else this._cancelGrab();
      return;
    }

    if (this._popup) { e.stopImmediatePropagation(); return; }

    const ndc = this._ndc(e);
    this._raycaster.setFromCamera(ndc, this._camera);

    // Right-click: context menu on anchor
    if (e.button === 2) {
      const hits = this._raycaster.intersectObjects([...this._markers.values()], false);
      if (hits.length > 0) {
        e.stopImmediatePropagation();
        e.preventDefault();
        const key = hits[0].object.userData.anchorKey as string;
        if (key !== this._selectedKey) this._selectAnchor(key);
        this._showContextMenu(e, key);
      }
      return;
    }

    if (e.button !== 0) return;

    // Rotation gizmo (rotate tool)
    if (this._tool === 'rotate' && this._rotGizmoGroup) {
      const rotHits = this._raycaster.intersectObjects(this._rotGizmoGroup.children, false);
      const rotHit = rotHits.find(h => h.object.userData.rotAxis);
      if (rotHit) {
        e.stopImmediatePropagation();
        this._startRotDrag(e, rotHit.object.userData.rotAxis as 'x' | 'y' | 'z');
        return;
      }
      // Click marker to re-select
      const mHits = this._raycaster.intersectObjects([...this._markers.values()], false);
      if (mHits.length) {
        const k = [...this._markers.entries()].find(([, m]) => m === mHits[0].object)?.[0];
        if (k) { e.stopImmediatePropagation(); this._selectAnchor(k); }
      }
      return;
    }

    // Select tool
    if (this._tool === 'select') {
      // Une poignee de profil passe avant les fleches et les anneaux : des spots
      // proches de l'ancre se trouvent dessous, et deviendraient inaccessibles.
      // Seule la poignee deja choisie leur cede la place, car ses fleches
      // partent de son centre.
      if (this._ledHandles.length) {
        const hh = this._raycaster.intersectObjects(this._ledHandles, false)
          .find((h) => !this._isLedFocus(h.object.userData.ledHandle as LedHandle));
        if (hh) {
          e.stopImmediatePropagation();
          this._startLedDrag(e, hh.object.userData.ledHandle as LedHandle);
          return;
        }
      }
      // Gizmo arrow drag
      if (this._gizmoGroup) {
        const hits = this._raycaster.intersectObject(this._gizmoGroup, true);
        if (hits.length > 0 && hits[0].object.userData.gizmoAxis) {
          e.stopImmediatePropagation();
          this._startDrag(e, hits[0].object.userData.gizmoAxis as string);
          return;
        }
      }
      // Rotation gizmo — also interactive in select mode for directional lights
      if (this._rotGizmoGroup) {
        const rotHits = this._raycaster.intersectObjects(this._rotGizmoGroup.children, false);
        const rotHit = rotHits.find(h => h.object.userData.rotAxis);
        if (rotHit) {
          e.stopImmediatePropagation();
          this._startRotDrag(e, rotHit.object.userData.rotAxis as 'x' | 'y' | 'z');
          return;
        }
      }
      // Poignees du profil LED selectionne
      if (this._ledHandles.length) {
        const hh = this._raycaster.intersectObjects(this._ledHandles, false)[0];
        if (hh) {
          e.stopImmediatePropagation();
          this._startLedDrag(e, hh.object.userData.ledHandle as LedHandle);
          return;
        }
      }
      // Marker select (+ arm direct-drag)
      const hits = this._raycaster.intersectObjects([...this._markers.values()], false);
      if (hits.length > 0) {
        e.stopImmediatePropagation();
        const key = hits[0].object.userData.anchorKey as string;
        this._selectAnchor(key);
        this._directDragKey = key;
        this._directDragStartX = e.clientX;
        this._directDragStartY = e.clientY;
        this._canvas.setPointerCapture(e.pointerId);
        return;
      }
      // Click empty → deselect
      this._clearGizmo(); this._clearRotGizmo();
      this._selectedKey = null;
      this._selChanged(null);
    }

    // Add tool
    if (this._tool === 'add') {
      const hits = this._raycaster.intersectObject(this._model, true);
      if (hits.length > 0) {
        e.stopImmediatePropagation();
        this._pendingPos = hits[0].point.clone();
        this._pendingNormal = null;
        if (hits[0].face) {
          const n = hits[0].face.normal.clone().transformDirection(hits[0].object.matrixWorld);
          // Face vue par l'arriere (maillage a simple face) : on la retourne vers la camera.
          if (n.dot(this._raycaster.ray.direction) > 0) n.negate();
          this._pendingNormal = n;
        }
        this._showEntityPicker();
      } else {
        // Click outside model — cancel placement
        this.setTool('select');
      }
    }
  };

  private _onPointerMove = (e: PointerEvent) => {
    if (!this._active) return;

    // Direct drag: click-drag on marker triggers grab (no G key needed)
    if (this._directDragKey) {
      const dx = e.clientX - this._directDragStartX;
      const dy = e.clientY - this._directDragStartY;
      if (dx * dx + dy * dy > 25) { // 5px threshold
        e.stopImmediatePropagation();
        this._pushUndo();
        // Compute offset so anchor doesn't teleport to cursor
        const anchor = this._anchors.get(this._directDragKey);
        const offset = new THREE.Vector3();
        if (anchor) {
          const ndc = this._ndc(e);
          this._raycaster.setFromCamera(ndc, this._camera);
          const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -anchor.position.y);
          const hit = new THREE.Vector3();
          if (this._raycaster.ray.intersectPlane(plane, hit)) {
            offset.subVectors(hit, anchor.position);
          }
        }
        this._startGrab(offset);
        this._directDragKey = null;
      }
      return;
    }

    // Poignee de profil LED
    if (this._ledDrag) {
      e.stopImmediatePropagation();
      this._moveLedHandle(e);
      return;
    }

    // G-grab mode
    if (this._grabMode && this._selectedKey) {
      e.stopImmediatePropagation();
      const ndc = this._ndc(e);
      this._raycaster.setFromCamera(ndc, this._camera);
      const hit = new THREE.Vector3();
      let plane = this._grabPlane; // horizontal XZ by default
      if (this._grabConstraint === 'y') {
        // For Y: use a camera-facing vertical plane through anchor
        const camDir = new THREE.Vector3();
        this._camera.getWorldDirection(camDir);
        camDir.y = 0; if (camDir.lengthSq() < 0.001) camDir.set(1, 0, 0); else camDir.normalize();
        const anchor = this._anchors.get(this._selectedKey)!;
        plane = new THREE.Plane().setFromNormalAndCoplanarPoint(camDir, anchor.position);
      }
      if (!this._raycaster.ray.intersectPlane(plane, hit)) return;
      const anchor = this._anchors.get(this._selectedKey)!;
      const newPos = anchor.position.clone();
      if (this._grabConstraint === 'x') newPos.x = hit.x - this._grabOffset.x;
      else if (this._grabConstraint === 'y') newPos.y = hit.y - this._grabOffset.y;
      else if (this._grabConstraint === 'z') newPos.z = hit.z - this._grabOffset.z;
      else { newPos.x = hit.x - this._grabOffset.x; newPos.z = hit.z - this._grabOffset.z; }
      anchor.position.copy(newPos);
      this._gizmoGroup?.position.copy(newPos);
      this._rotGizmoGroup?.position.copy(newPos);
      this._markers.get(this._selectedKey)?.position.copy(newPos);
      this._changed();
      return;
    }

    // Rotation drag (must come before translation drag check)
    if (this._rotAxis && this._rotGizmoGroup && this._selectedKey) {
      e.stopImmediatePropagation();
      const ndc = this._ndc(e);
      this._raycaster.setFromCamera(ndc, this._camera);
      const hit = new THREE.Vector3();
      if (!this._raycaster.ray.intersectPlane(this._rotDragPlane, hit)) return;
      const center = this._rotGizmoGroup.position;
      const current = new THREE.Vector3().subVectors(hit, center).normalize();
      const axisVec = this._rotAxis === 'x' ? new THREE.Vector3(1, 0, 0)
        : this._rotAxis === 'y' ? new THREE.Vector3(0, 1, 0)
        : new THREE.Vector3(0, 0, 1);
      const angle = this._rotDragStart.angleTo(current);
      const cross = new THREE.Vector3().crossVectors(this._rotDragStart, current);
      const sign = cross.dot(axisVec) >= 0 ? 1 : -1;
      const quat = new THREE.Quaternion().setFromAxisAngle(axisVec, angle * sign);
      const initDir = new THREE.Vector3(...this._rotInitDir);
      initDir.applyQuaternion(quat).normalize();
      const newDir: [number, number, number] = [initDir.x, initDir.y, initDir.z];
      const anchor = this._anchors.get(this._selectedKey);
      if (anchor) {
        anchor.lightDirection = newDir;
        // Le profil est defini en decalages libres autour de l'ancre : sans
        // cela, tourner autour de Y un LED qui emet vers le bas ne changeait rien.
        const init = this._rotInitLed;
        if (init) {
          const turn = (p: [number, number, number]): [number, number, number] => {
            const r = new THREE.Vector3(...p).applyQuaternion(quat);
            return [r.x, r.y, r.z];
          };
          const led: LedProfile = structuredClone(init);
          if (init.segments) led.segments = init.segments.map(([a, b]) => [turn(a), turn(b)]);
          if (init.points) led.points = init.points.map(turn);
          if (init.shape === 'rect') {
            const start = ledFrame(emissionDir(this._rotInitDir), init.spin ?? 0).u.applyQuaternion(quat);
            const to = new THREE.Vector3(...newDir);
            const base = ledFrame(to).u;
            led.spin = Math.atan2(to.dot(new THREE.Vector3().crossVectors(base, start)), base.dot(start));
          }
          anchor.led = led;
        }
      }
      this._updateRotGizmoDir(newDir);
      this._changed();
      return;
    }

    if (!this._dragAxis) {
      const ndc = this._ndc(e);
      this._raycaster.setFromCamera(ndc, this._camera);
      const hits = this._raycaster.intersectObjects([...this._markers.values()], false);
      const newHover = hits.length > 0 ? (hits[0].object.userData.anchorKey as string) : null;
      if (newHover !== this._hoveredKey) {
        if (this._hoveredKey && this._hoveredKey !== this._selectedKey) {
          const a = this._anchors.get(this._hoveredKey);
          (this._markers.get(this._hoveredKey)?.material as THREE.MeshBasicMaterial)?.color.setHex(
            a?.hidden ? 0x888888 : 0xFFDD00
          );
        }
        if (newHover && newHover !== this._selectedKey) {
          (this._markers.get(newHover)?.material as THREE.MeshBasicMaterial)?.color.setHex(0xFFFFAA);
        }
        this._hoveredKey = newHover;
        this._canvas.style.cursor = newHover ? 'grab' : '';
      }
    }

    if (!this._dragAxis || !this._gizmoGroup) return;
    e.stopImmediatePropagation();
    const ndc = this._ndc(e);
    this._raycaster.setFromCamera(ndc, this._camera);
    const hit = new THREE.Vector3();
    if (!this._raycaster.ray.intersectPlane(this._dragPlane, hit)) return;
    const delta = new THREE.Vector3().subVectors(hit, this._dragStart);
    const axisDir = AXIS_DIRS[this._dragAxis];
    const dist = delta.dot(axisDir);
    const newPos = this._gizmoGroup.position.clone().addScaledVector(axisDir, dist);
    this._dragStart.copy(hit);
    this._gizmoGroup.position.copy(newPos);
    if (this._ledFocus && this._selectedKey) {
      // Un seul point du profil : l'ancre reste ou elle est.
      const anchor = this._anchors.get(this._selectedKey);
      const rel: [number, number, number] | null = anchor
        ? [newPos.x - anchor.position.x, newPos.y - anchor.position.y, newPos.z - anchor.position.z]
        : null;
      const f = this._ledFocus;
      if (anchor?.led && rel) {
        if (f.kind === 'spot' && anchor.led.points?.[f.index]) anchor.led.points[f.index] = rel;
        else if (f.kind === 'end' && anchor.led.segments?.[f.index]) anchor.led.segments[f.index][f.end] = rel;
      }
    } else if (this._selectedKey) {
      const anchor = this._anchors.get(this._selectedKey);
      if (anchor) {
        anchor.position.copy(newPos);
        this._markers.get(this._selectedKey)?.position.copy(newPos);
      }
    }
    this._changed();
  };

  private _onPointerUp = (e: PointerEvent) => {
    if (this._directDragKey) {
      // Tap without drag — just a selection, pointer was captured
      this._canvas.releasePointerCapture(e.pointerId);
      this._directDragKey = null;
    }
    // Direct drag ends on pointerup — confirm grab so _gizmoDragging is cleared
    // (G-grab is confirmed on next pointerdown, so _grabMode will already be false here)
    if (this._grabMode && e.button === 0) {
      this._canvas.releasePointerCapture(e.pointerId);
      this._confirmGrab();
    }
    if (this._ledDrag) {
      this._canvas.releasePointerCapture(e.pointerId);
      this._ledDrag = null;
      if (this._selectedKey) this._recenterLed(this._selectedKey);
      this.onDragEnd?.();
    }
    if (this._rotAxis) {
      this._canvas.releasePointerCapture(e.pointerId);
      this._rotAxis = null;
      this.onDragEnd?.();
    }
    if (this._dragAxis) {
      this._canvas.releasePointerCapture(e.pointerId);
      this._dragAxis = null;
      if (this._ledFocus && this._selectedKey) this._recenterLed(this._selectedKey);
      this.onDragEnd?.();
    }
  };
}
