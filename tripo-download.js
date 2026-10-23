/**
 * tripo-download.js
 * Downloads the model currently shown in Tripo Studio as a textured .glb.
 *
 * USAGE
 *   Open studio.tripo3d.ai, open a model in the 3D workspace, wait until it is
 *   visible, open DevTools → Console, paste this whole file, press Enter.
 *   The .glb lands in your Downloads folder; import it into Blender with
 *   File → Import → glTF 2.0.
 *
 * Based on JackTYM's gist (baa22f25) plus the fixes posted in its comments.
 * Everything happens in the page: the model is read out of the live Three.js
 * scene and re-packed as GLB. Only assets already loaded by the viewer can be
 * exported.
 */
(async function downloadTripoModel() {
  'use strict';

  const OPTIONS = {
    // Tripo's generated normals are unreliable; leaving them out makes Blender
    // recompute smooth normals from face winding.
    includeNormals: false,
    // Below this vertex count a mesh is treated as a helper (grid, backdrop)
    // when no "tripo_node_*" mesh is present.
    minHelperVertexCount: 64,
  };

  const TAG = '[tripo]';
  const log = (...a) => console.log(TAG, ...a);
  const warn = (...a) => console.warn(TAG, ...a);

  const GL = { FLOAT: 5126, UNSIGNED_SHORT: 5123, UNSIGNED_INT: 5125, TRIANGLES: 4 };
  const WRAP_TO_GL = { 1000: 10497, 1001: 33071, 1002: 33648 };
  const align4 = (n) => (n + 3) & ~3;
  const bytesOf = (typed) => new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength);
  const unref = (v) => {
    const x = v && v.__v_isRef ? v.value : v;
    return (x && x.__v_raw) || x;
  };

  // ── Locate the TresJS scene ─────────────────────────────────────────────
  // Nuxt/Vue component instances form a tree that also covers Suspense and
  // Teleport branches, so the TresJS context is usually in there.
  function* walkInstances(root) {
    const seen = new Set();
    const stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);
      if (Array.isArray(node)) {
        stack.push(...node);
        continue;
      }
      if ('subTree' in node && 'vnode' in node && 'uid' in node) {
        yield node;
        stack.push(node.subTree);
        if (node.suspense) stack.push(node.suspense.activeBranch);
        continue;
      }
      if (node.component) stack.push(node.component);
      if (node.suspense) stack.push(node.suspense.activeBranch);
      if (Array.isArray(node.children)) stack.push(node.children);
      if (Array.isArray(node.dynamicChildren)) stack.push(node.dynamicChildren);
    }
  }

  function sceneFromInstance(inst) {
    for (const candidate of [inst.provides?.useTres, inst.exposed?.context, inst.setupState?.context]) {
      const ctx = unref(candidate);
      const scene = unref(ctx?.scene);
      if (scene?.isScene) return scene;
    }
    return null;
  }

  // Fallback: walk arbitrary object graphs (Pinia stores, canvases, globals).
  function findSceneDeep(roots, budget = 400000) {
    const seen = new Set();
    const queue = roots.slice();
    for (let i = 0; i < queue.length && seen.size < budget && queue.length < 2000000; i++) {
      let v;
      try {
        v = unref(queue[i]);
      } catch {
        continue;
      }
      if (!v || typeof v !== 'object' || seen.has(v)) continue;
      seen.add(v);

      if (v.isScene) return v;
      if (v.isObject3D) {
        let root = v;
        while (root.parent) root = root.parent;
        if (root.isScene) return root;
        continue;
      }
      if (v === window || ArrayBuffer.isView(v) || v instanceof ArrayBuffer) continue;
      if (v instanceof Node) {
        queue.push(v.__vueParentComponent, v.__vnode);
        continue;
      }
      if (v instanceof Map) {
        for (const [k, x] of v) queue.push(k, x);
        continue;
      }
      if (v instanceof Set) {
        for (const x of v) queue.push(x);
        continue;
      }
      try {
        for (const k of Object.keys(v)) queue.push(v[k]);
      } catch {
        /* cross-origin or throwing getter */
      }
    }
    return null;
  }

  function userGlobals() {
    try {
      const iframe = document.createElement('iframe');
      iframe.style.display = 'none';
      document.body.appendChild(iframe);
      const builtins = new Set(Object.getOwnPropertyNames(iframe.contentWindow));
      iframe.remove();
      return Object.getOwnPropertyNames(window)
        .filter((k) => !builtins.has(k))
        .map((k) => {
          try {
            return window[k];
          } catch {
            return null;
          }
        });
    } catch {
      return [];
    }
  }

  // ── glTF helpers ────────────────────────────────────────────────────────
  // Reads any BufferAttribute / InterleavedBufferAttribute (including
  // normalized integer attributes) into a tightly packed Float32Array.
  function readAttribute(attr, itemSize = attr.itemSize) {
    const getters = ['getX', 'getY', 'getZ', 'getW'];
    const out = new Float32Array(attr.count * itemSize);
    for (let i = 0; i < attr.count; i++) {
      for (let k = 0; k < itemSize; k++) out[i * itemSize + k] = attr[getters[k]](i);
    }
    return out;
  }

  function computeMinMax(data, itemSize) {
    const min = new Array(itemSize).fill(Infinity);
    const max = new Array(itemSize).fill(-Infinity);
    for (let i = 0; i < data.length; i += itemSize) {
      for (let k = 0; k < itemSize; k++) {
        const v = data[i + k];
        if (v < min[k]) min[k] = v;
        if (v > max[k]) max[k] = v;
      }
    }
    return { min, max };
  }

  try {
    const appEl = [document.querySelector('#__nuxt'), ...document.querySelectorAll('[data-v-app]')].find(
      (el) => el && el.__vue_app__
    );
    if (!appEl) throw new Error('Vue app not found — open a Tripo Studio model page and let the viewer load.');
    const vueApp = appEl.__vue_app__;

    const rootInstance =
      vueApp._instance ||
      vueApp.config?.globalProperties?.$router?.currentRoute?.value?.matched?.[0]?.instances?.default?._;
    if (!rootInstance) throw new Error('Root Vue component instance not found.');

    const instances = [...walkInstances(rootInstance)];
    let scene = null;
    for (const inst of instances) {
      scene = sceneFromInstance(inst);
      if (scene) break;
    }

    if (!scene) {
      const pinia = vueApp.config?.globalProperties?.$pinia;
      scene = findSceneDeep([
        ...(window.__tripoScenes ?? []).slice().reverse(),
        ...instances.flatMap((i) => [i.exposed, i.provides, i.setupState, i.refs, i.props]),
        pinia?._s,
        pinia?.state,
        vueApp.config?.globalProperties,
        ...document.querySelectorAll('canvas'),
        rootInstance,
        ...userGlobals(),
      ]);
    }

    if (!scene) {
      // Three.js announces every new Scene to __THREE_DEVTOOLS__, so hooking
      // it now catches the next scene the app builds.
      if (!window.__tripoScenes) {
        window.__tripoScenes = [];
        const devtools = window.__THREE_DEVTOOLS__ || (window.__THREE_DEVTOOLS__ = new EventTarget());
        devtools.addEventListener('observe', (e) => {
          if (e.detail?.isScene) window.__tripoScenes.push(e.detail);
        });
      }
      throw new Error(
        'Three.js scene not found. Switch to another model in the app (do not reload the page), ' +
          'switch back, then run this script again.'
      );
    }
    log('scene found — children:', scene.children.length);

    // ── Collect model meshes ──────────────────────────────────────────────
    scene.updateMatrixWorld(true);
    const visibleMeshes = [];
    scene.traverseVisible((o) => {
      if (o.isMesh && o.geometry?.attributes?.position?.count > 0) visibleMeshes.push(o);
    });
    if (!visibleMeshes.length) throw new Error('Scene found but it has no visible meshes — let the viewer finish loading.');

    const vertexCountOf = (m) => m.geometry.attributes.position.count;
    const underTripoNode = (m) => {
      for (let o = m; o; o = o.parent) if (/^tripo_node/.test(o.name)) return true;
      return false;
    };

    let meshes = visibleMeshes.filter(underTripoNode);
    if (!meshes.length) meshes = visibleMeshes.filter((m) => vertexCountOf(m) >= OPTIONS.minHelperVertexCount);
    if (!meshes.length) meshes = visibleMeshes;

    for (const m of meshes) {
      if (m.isInstancedMesh) warn(`"${m.name}" is instanced — only the base geometry is exported.`);
      if (m.isSkinnedMesh) warn(`"${m.name}" is skinned — exported in bind pose, without skeleton.`);
      log(`mesh "${m.name || '(unnamed)'}": ${vertexCountOf(m)} vertices, ${m.geometry.index?.count ?? 0} indices`);
    }

    // ── glTF builder state ────────────────────────────────────────────────
    const binParts = [];
    let binLength = 0;
    const bufferViews = [];
    const accessors = [];
    const images = [];
    const samplers = [];
    const textures = [];
    const materials = [];
    const gltfMeshes = [];
    const nodes = [];

    const imageCache = new Map();
    const textureCache = new Map();
    const materialCache = new Map();

    function addBufferView(bytes, target) {
      const byteOffset = binLength;
      binParts.push({ byteOffset, bytes });
      binLength = align4(byteOffset + bytes.byteLength);
      bufferViews.push({ buffer: 0, byteOffset, byteLength: bytes.byteLength, ...(target ? { target } : {}) });
      return bufferViews.length - 1;
    }

    function addAccessor(typed, componentType, type, count, target, extra = {}) {
      accessors.push({
        bufferView: addBufferView(bytesOf(typed), target),
        byteOffset: 0,
        componentType,
        count,
        type,
        ...extra,
      });
      return accessors.length - 1;
    }

    // ── Textures ──────────────────────────────────────────────────────────
    async function imageToPNG(tex) {
      const img = tex.image;
      if (!img) return null;
      if (tex.isCompressedTexture) {
        warn(`texture "${tex.name}" is GPU-compressed (KTX2/Basis) and cannot be read back — skipped.`);
        return null;
      }

      const w = img.width ?? img.naturalWidth ?? img.videoWidth;
      const h = img.height ?? img.naturalHeight ?? img.videoHeight;
      if (!w || !h) {
        warn(`texture "${tex.name}" has no readable pixels (closed ImageBitmap?) — skipped.`);
        return null;
      }

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx2d = canvas.getContext('2d');

      if (tex.isDataTexture) {
        const data = img.data;
        if (!(data instanceof Uint8Array || data instanceof Uint8ClampedArray) || data.length !== w * h * 4) {
          warn(`DataTexture "${tex.name}" is not 8-bit RGBA — skipped.`);
          return null;
        }
        ctx2d.putImageData(new ImageData(new Uint8ClampedArray(data), w, h), 0, 0);
      } else {
        ctx2d.drawImage(img, 0, 0, w, h);
      }

      try {
        const blob = await new Promise((resolve, reject) =>
          canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob returned null'))), 'image/png')
        );
        return new Uint8Array(await blob.arrayBuffer());
      } catch (e) {
        warn(`could not encode texture "${tex.name}" (cross-origin canvas taint?) — skipped.`, e);
        return null;
      }
    }

    async function addTexture(tex) {
      if (!tex) return null;
      if (textureCache.has(tex)) return textureCache.get(tex);

      let imageIndex = imageCache.get(tex.image);
      if (imageIndex === undefined) {
        const png = await imageToPNG(tex);
        if (!png) {
          textureCache.set(tex, null);
          return null;
        }
        images.push({ mimeType: 'image/png', bufferView: addBufferView(png) });
        imageIndex = images.length - 1;
        imageCache.set(tex.image, imageIndex);
        log(`texture ${tex.image.width}×${tex.image.height} → ${(png.byteLength / 1024).toFixed(0)} KB PNG`);
      }

      if (
        (tex.offset && (tex.offset.x || tex.offset.y)) ||
        (tex.repeat && (tex.repeat.x !== 1 || tex.repeat.y !== 1)) ||
        tex.rotation
      ) {
        warn(`texture "${tex.name}" uses offset/repeat/rotation, which is not exported.`);
      }

      samplers.push({
        magFilter: tex.magFilter === 1003 ? 9728 : 9729,
        wrapS: WRAP_TO_GL[tex.wrapS] ?? 10497,
        wrapT: WRAP_TO_GL[tex.wrapT] ?? 10497,
      });
      textures.push({ source: imageIndex, sampler: samplers.length - 1 });
      const index = textures.length - 1;
      textureCache.set(tex, index);
      return index;
    }

    // ── Materials ─────────────────────────────────────────────────────────
    async function addMaterial(mat, hasUV) {
      if (!mat) return undefined;
      const variant = hasUV ? 'uv' : 'plain';
      let variants = materialCache.get(mat);
      if (variants?.has(variant)) return variants.get(variant);
      if (!variants) materialCache.set(mat, (variants = new Map()));

      const pbr = {
        baseColorFactor: mat.color ? [mat.color.r, mat.color.g, mat.color.b, mat.opacity ?? 1] : [1, 1, 1, mat.opacity ?? 1],
        metallicFactor: mat.metalness ?? 0,
        roughnessFactor: mat.roughness ?? 1,
      };
      const out = {
        name: mat.name || `material_${materials.length}`,
        pbrMetallicRoughness: pbr,
        doubleSided: mat.side === 2, // THREE.DoubleSide
      };

      if (hasUV) {
        const baseColor = await addTexture(mat.map);
        if (baseColor !== null) pbr.baseColorTexture = { index: baseColor };

        // Three reads roughness from G and metalness from B — same as glTF.
        const mr = await addTexture(mat.metalnessMap || mat.roughnessMap);
        if (mr !== null) pbr.metallicRoughnessTexture = { index: mr };

        const normal = await addTexture(mat.normalMap);
        if (normal !== null) out.normalTexture = { index: normal, scale: mat.normalScale?.x ?? 1 };

        if (mat.aoMap && !mat.aoMap.channel) {
          const ao = await addTexture(mat.aoMap);
          if (ao !== null) out.occlusionTexture = { index: ao, strength: mat.aoMapIntensity ?? 1 };
        }
      }

      if (mat.emissive) {
        const k = mat.emissiveIntensity ?? 1;
        const e = [mat.emissive.r * k, mat.emissive.g * k, mat.emissive.b * k].map((v) => Math.min(1, v));
        if (e.some((v) => v > 0)) out.emissiveFactor = e;
      }
      if (hasUV) {
        const emissive = await addTexture(mat.emissiveMap);
        if (emissive !== null) {
          out.emissiveTexture = { index: emissive };
          out.emissiveFactor ??= [1, 1, 1];
        }
      }

      if (mat.alphaTest > 0) {
        out.alphaMode = 'MASK';
        out.alphaCutoff = mat.alphaTest;
      } else if (mat.transparent && (mat.opacity < 1 || mat.alphaMap || mat.map)) {
        out.alphaMode = 'BLEND';
      }

      materials.push(out);
      const index = materials.length - 1;
      variants.set(variant, index);
      return index;
    }

    // ── Meshes → primitives ───────────────────────────────────────────────
    for (const mesh of meshes) {
      const geo = mesh.geometry;
      const vCount = geo.attributes.position.count;
      const matList = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      const attributes = {};

      const positions = readAttribute(geo.attributes.position, 3);
      attributes.POSITION = addAccessor(positions, GL.FLOAT, 'VEC3', vCount, GL.ARRAY_BUFFER, computeMinMax(positions, 3));

      if (OPTIONS.includeNormals && geo.attributes.normal) {
        const normals = readAttribute(geo.attributes.normal, 3);
        for (let i = 0; i < normals.length; i += 3) {
          const len = Math.hypot(normals[i], normals[i + 1], normals[i + 2]) || 1;
          normals[i] /= len;
          normals[i + 1] /= len;
          normals[i + 2] /= len;
        }
        attributes.NORMAL = addAccessor(normals, GL.FLOAT, 'VEC3', vCount, GL.ARRAY_BUFFER);
      }

      if (geo.attributes.uv) {
        const uvs = readAttribute(geo.attributes.uv, 2);
        // glTF UV origin is the image's top-left. Three only flips non-ImageBitmap
        // sources when flipY is set, so only those need their V flipped back.
        const map = matList.find((m) => m?.map)?.map;
        const needsFlip = map && map.flipY && !(typeof ImageBitmap !== 'undefined' && map.image instanceof ImageBitmap);
        if (needsFlip) for (let i = 1; i < uvs.length; i += 2) uvs[i] = 1 - uvs[i];
        attributes.TEXCOORD_0 = addAccessor(uvs, GL.FLOAT, 'VEC2', vCount, GL.ARRAY_BUFFER);
      }

      if (geo.attributes.color && matList.some((m) => m?.vertexColors)) {
        const itemSize = geo.attributes.color.itemSize === 4 ? 4 : 3;
        const colors = readAttribute(geo.attributes.color, itemSize);
        attributes.COLOR_0 = addAccessor(colors, GL.FLOAT, itemSize === 4 ? 'VEC4' : 'VEC3', vCount, GL.ARRAY_BUFFER);
      }

      const index = geo.index;
      const totalCount = index ? index.count : vCount;
      const drawStart = geo.drawRange?.start ?? 0;
      const drawCount = Math.min(geo.drawRange?.count ?? Infinity, totalCount - drawStart);
      const groups = geo.groups?.length ? geo.groups : [{ start: drawStart, count: drawCount, materialIndex: 0 }];

      const IndexArray = vCount > 65535 ? Uint32Array : Uint16Array;
      const indexCompType = vCount > 65535 ? GL.UNSIGNED_INT : GL.UNSIGNED_SHORT;

      const primitives = [];
      for (const group of groups) {
        const start = group.start;
        const count = Math.min(group.count, totalCount - start);
        if (count <= 0) continue;

        const primitive = { attributes, mode: GL.TRIANGLES };

        if (index) {
          const idx = new IndexArray(count);
          idx.set(index.array.subarray(start, start + count));
          primitive.indices = addAccessor(idx, indexCompType, 'SCALAR', count, GL.ELEMENT_ARRAY_BUFFER);
        } else if (start !== 0 || count !== totalCount) {
          const idx = new IndexArray(count);
          for (let i = 0; i < count; i++) idx[i] = start + i;
          primitive.indices = addAccessor(idx, indexCompType, 'SCALAR', count, GL.ELEMENT_ARRAY_BUFFER);
        }

        const material = await addMaterial(
          matList[group.materialIndex ?? 0] ?? matList[0],
          attributes.TEXCOORD_0 !== undefined
        );
        if (material !== undefined) primitive.material = material;
        primitives.push(primitive);
      }

      gltfMeshes.push({ name: mesh.name || `mesh_${gltfMeshes.length}`, primitives });

      const node = { name: mesh.name || `node_${nodes.length}`, mesh: gltfMeshes.length - 1 };
      const m = mesh.matrixWorld.elements;
      if (!m.every((v, i) => v === (i % 5 === 0 ? 1 : 0))) node.matrix = Array.from(m);
      nodes.push(node);
    }

    // ── Build glTF JSON ───────────────────────────────────────────────────
    const gltf = {
      asset: { version: '2.0', generator: 'tripo-download' },
      scene: 0,
      scenes: [{ name: 'Scene', nodes: nodes.map((_, i) => i) }],
      nodes,
      meshes: gltfMeshes,
      accessors,
      bufferViews,
      buffers: [{ byteLength: binLength }],
    };
    if (materials.length) gltf.materials = materials;
    if (textures.length) Object.assign(gltf, { textures, samplers, images });

    // ── Assemble GLB ──────────────────────────────────────────────────────
    const jsonBytes = new TextEncoder().encode(JSON.stringify(gltf));
    const jsonPadded = align4(jsonBytes.length);
    const totalSize = 12 + 8 + jsonPadded + 8 + binLength;

    const glb = new ArrayBuffer(totalSize);
    const dv = new DataView(glb);
    const buf = new Uint8Array(glb);

    dv.setUint32(0, 0x46546c67, true); // "glTF"
    dv.setUint32(4, 2, true);
    dv.setUint32(8, totalSize, true);
    dv.setUint32(12, jsonPadded, true);
    dv.setUint32(16, 0x4e4f534a, true); // "JSON"
    buf.set(jsonBytes, 20);
    buf.fill(0x20, 20 + jsonBytes.length, 20 + jsonPadded); // JSON chunk is space-padded
    const binStart = 20 + jsonPadded;
    dv.setUint32(binStart, binLength, true);
    dv.setUint32(binStart + 4, 0x004e4942, true); // "BIN\0"
    for (const part of binParts) buf.set(part.bytes, binStart + 8 + part.byteOffset);

    // Self-check: a malformed header would make Blender reject the download.
    if (dv.getUint32(0, true) !== 0x46546c67 || dv.getUint32(8, true) !== totalSize) {
      throw new Error('GLB header validation failed — nothing was downloaded.');
    }

    // ── Download ──────────────────────────────────────────────────────────
    const modelId = (location.pathname.split('/').filter(Boolean).pop() || 'model').replace(/[^\w.-]+/g, '_');
    const filename = `tripo_${modelId}.glb`;
    const blobUrl = URL.createObjectURL(new Blob([glb], { type: 'model/gltf-binary' }));

    const anchor = document.createElement('a');
    anchor.href = blobUrl;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 10000);

    const totalVerts = meshes.reduce((n, m) => n + vertexCountOf(m), 0);
    log(
      `✓ ${filename} — ${(totalSize / 1048576).toFixed(2)} MB, ${meshes.length} mesh(es), ` +
        `${totalVerts} vertices, ${textures.length} texture(s)`
    );
    return { filename, meshes: meshes.length, vertices: totalVerts, textures: textures.length };
  } catch (err) {
    console.error(TAG, err.message);
    throw err;
  }
})();
