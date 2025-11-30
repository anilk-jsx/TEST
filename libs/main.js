window.addEventListener("load", init);

var scene;
var postProcScene;
var shaderPassScene;
var camera;
var postProcCamera;
var controls;
var renderer;
var canvas;

var preventOnControlsChangeReset = false;

var postProcQuadMaterial;

// whether the user interacted (stops autoplay)
var userInteracted = false;
// store initial camera position for autoplay
var initialCameraPos = null;
// enable small auto-rotation at start
var autoRotateEnabled = true;
// pause autoplay for a short time after manual interaction (ms)
var autoplayPause = false;
var autoplayPauseTimeoutMs = 3000;
var autoplayResumeTimer = null;
// seed for deterministic-ish random motion per session
var autoplaySeed = Math.random() * 1000;
// base angular speed (radians per second)
var autoplayBaseSpeed = 0.2;
// phase offset so autoplay can resume from current camera angle
var autoplayPhaseOffset = 0;
// base radius used by autoplay (can be updated on resume to avoid snaps)
var autoplayBaseRadius = null;
// base vertical position used by autoplay
var autoplayBaseY = null;
// pointer/camera drag tracking to capture last movement direction
var isPointerDown = false;
var prevCamAngle = null;
var prevCamTime = null;
var lastAngularVelocity = 0; // radians per second

var capturerStarted = false;

let lines = [ ];
let linesGeometry;
let linesMaterial;

let quads = [ ];
let quadsGeometry;
let quadsMaterial;

let shaderPassMaterial;

let samples = 0;

var offscreenRT;

// The threejs version used in this repo was modified at line: 23060  to disable frustum culling
let frames = 0;

var controls = { };

function init() {    
    if(setGlobals) setGlobals();

    initCurlNoise();

    renderer = new THREE.WebGLRenderer( {  } );
    renderer.setPixelRatio( Math.min(window.devicePixelRatio || 1, 2) );
    renderer.setSize( innerWidth, innerHeight );
    renderer.autoClear = false;
    document.body.appendChild(renderer.domElement);
    canvas = renderer.domElement;


    scene           = new THREE.Scene();
    postProcScene   = new THREE.Scene();
    shaderPassScene = new THREE.Scene();

    camera = new THREE.PerspectiveCamera( 20, innerWidth / innerHeight, 2, 2000 );
    // let dirVec = new THREE.Vector3(-5, -5, 10).normalize().multiplyScalar(49);
    // camera.position.set( dirVec.x, dirVec.y, dirVec.z );
    // camera.position.set( 0, 0, 100 );
    camera.position.set(cameraPosition.x, cameraPosition.y, cameraPosition.z);


    postProcCamera = new THREE.PerspectiveCamera( 20, innerWidth / innerHeight, 2, 2000 );
    postProcCamera.position.set(0, 0, 10);

    // respond to window resizes
    window.addEventListener('resize', onWindowResize);
    window.addEventListener('orientationchange', onWindowResize);

    controls = new THREE.OrbitControls(camera, renderer.domElement);
    controls.target.set(cameraTarget.x, cameraTarget.y, cameraTarget.z);
    controls.rotateSpeed     = 1;
	controls.minAzimuthAngle = -Infinity; 
	controls.maxAzimuthAngle = +Infinity; 
	controls.minPolarAngle   = 0;      
    controls.maxPolarAngle   = Math.PI - 0; 

    controls.addEventListener("change", function() {
        if(!preventOnControlsChangeReset)
            resetCanvas();
    });

    // remember initial camera position for autoplay orbit
    initialCameraPos = camera.position.clone();
    // initialize autoplay base radius and Y from the initial camera position
    let initRadiusVec = initialCameraPos.clone().sub(controls.target);
    autoplayBaseRadius = initRadiusVec.length();
    autoplayBaseY = initialCameraPos.y;

    // mark user interaction — pause autoplay briefly, then resume
    function resumeAutoplay() {
        // compute current time and the autoplay angle at this moment
        let tNow = Date.now() * 0.001;
        let computedAngle = tNow * autoplayBaseSpeed
                            + Math.sin(tNow * 0.6 + autoplaySeed * 0.01) * 0.6
                            + Math.cos(tNow * 0.37 + autoplaySeed * 0.021) * 0.3;

        // current camera angle and radius in XZ plane
        let curX = camera.position.x - controls.target.x;
        let curZ = camera.position.z - controls.target.z;
        let currentAngle = Math.atan2(curZ, curX);
        let currentRadius = Math.sqrt(curX*curX + curZ*curZ);

        // set phase offset so angle(t) + offset === currentAngle
        autoplayPhaseOffset = currentAngle - computedAngle;

        // update base radius and Y so motion continues smoothly from current position
        autoplayBaseRadius = currentRadius;
        autoplayBaseY = camera.position.y;

        // if we have a recent measured angular velocity from user drag, use it to set autoplayBaseSpeed
        // clamp to reasonable range
        if(Math.abs(lastAngularVelocity) > 0.0001) {
            var speed = Math.abs(lastAngularVelocity);
            // clamp speed between 0.02 and 1.5 rad/s for safety
            speed = Math.max(0.02, Math.min(speed, 1.5));
            autoplayBaseSpeed = speed * (lastAngularVelocity < 0 ? -1 : 1);
        }

        autoplayPause = false;
    }

    function onUserInteraction() {
        userInteracted = true;
        autoplayPause = true;
        if(autoplayResumeTimer) clearTimeout(autoplayResumeTimer);
        autoplayResumeTimer = setTimeout(resumeAutoplay, autoplayPauseTimeoutMs);
    }

    window.addEventListener('mousedown', onUserInteraction);
    window.addEventListener('touchstart', onUserInteraction);
    window.addEventListener('wheel', onUserInteraction);
    window.addEventListener('keydown', onUserInteraction);

    // track drag start/stop to measure camera angular velocity
    window.addEventListener('pointerdown', function(){
        isPointerDown = true;
        // initialize angle/time
        let cx = camera.position.x - controls.target.x;
        let cz = camera.position.z - controls.target.z;
        prevCamAngle = Math.atan2(cz, cx);
        prevCamTime = Date.now() * 0.001;
        lastAngularVelocity = 0;
    });

    window.addEventListener('pointermove', function(){
        if(!isPointerDown) return;
        // compute current angle and time
        let nowT = Date.now() * 0.001;
        let cx = camera.position.x - controls.target.x;
        let cz = camera.position.z - controls.target.z;
        let a = Math.atan2(cz, cx);
        if(prevCamAngle !== null && prevCamTime !== null) {
            let dt = nowT - prevCamTime;
            if(dt > 0.0001) {
                // shortest angle delta
                let da = a - prevCamAngle;
                if(da > Math.PI) da -= Math.PI * 2;
                if(da < -Math.PI) da += Math.PI * 2;
                lastAngularVelocity = da / dt;
            }
        }
        prevCamAngle = a;
        prevCamTime = nowT;
    });

    window.addEventListener('pointerup', function(){
        isPointerDown = false;
        // pointer release will trigger onPointerRelease which debounces resume
    });

    // resume autoplay shortly after the user releases pointer (so motion restarts quickly)
    function onPointerRelease() {
        if(autoplayResumeTimer) clearTimeout(autoplayResumeTimer);
        // small debounce to let the final drag/interaction settle
        autoplayResumeTimer = setTimeout(resumeAutoplay, 200);
    }

    window.addEventListener('mouseup', onPointerRelease);
    window.addEventListener('touchend', onPointerRelease);
    window.addEventListener('pointerup', onPointerRelease);



    // choose render target type: prefer FloatType for quality but fallback to UnsignedByteType on devices
    var rtType = THREE.UnsignedByteType;
    try {
        // three.js exposes capabilities; prefer float when supported
        if(renderer && renderer.capabilities) {
            // WebGL2 typically supports float render targets
            if(renderer.capabilities.isWebGL2) {
                rtType = THREE.FloatType;
            } else {
                // check for OES_texture_float support on WebGL1
                var ext = renderer.extensions && renderer.extensions.get ? renderer.extensions.get('OES_texture_float') : null;
                if(ext) rtType = THREE.FloatType;
            }
        }
    } catch(e) {
        rtType = THREE.UnsignedByteType;
    }

    offscreenRT = new THREE.WebGLRenderTarget(innerWidth, innerHeight, {
        stencilBuffer: false,
        depthBuffer: false,
        type: rtType,
    });

    var postProcQuadGeo = new THREE.PlaneBufferGeometry(2,2);
    postProcQuadMaterial = new THREE.ShaderMaterial({
        vertexShader: postprocv,
        fragmentShader: postprocf,
        uniforms: {
            texture: { type: "t", value: offscreenRT.texture },
            uSamples: { value: samples },
            uExposure: { value: exposure },
            uBackgroundColor: new THREE.Uniform(new THREE.Vector3(backgroundColor[0], backgroundColor[1], backgroundColor[2])),
            uResolution: new THREE.Uniform(new THREE.Vector2(innerWidth, innerHeight)),
            uCameraPosition: new THREE.Uniform(new THREE.Vector3(0,0,0)),
        },
        side: THREE.DoubleSide,
    });
    postProcScene.add(new THREE.Mesh(postProcQuadGeo, postProcQuadMaterial));




    var shaderPassQuadGeo = new THREE.PlaneBufferGeometry(2,2);
    shaderPassMaterial = new THREE.ShaderMaterial({
        vertexShader: shaderpassv,
        fragmentShader: shaderpassf,
        uniforms: {
            uTime: { value: 0 },
            uResolution: new THREE.Uniform(new THREE.Vector2(innerWidth, innerHeight)),
            uCameraPosition: new THREE.Uniform(new THREE.Vector3(0,0,0)),
            uRandoms: new THREE.Uniform(new THREE.Vector4(0,0,0,0)),
            uBokehStrength: { value: 0 },
        },
        side:           THREE.DoubleSide,
        depthTest:      false,

        blending:      THREE.CustomBlending,
        blendEquation: THREE.AddEquation,
        blendSrc:      THREE.OneFactor, 
        blendSrcAlpha: THREE.OneFactor,
        blendDst:      THREE.OneFactor, 
        blendDstAlpha: THREE.OneFactor,  
    });
    shaderPassScene.add(new THREE.Mesh(shaderPassQuadGeo, shaderPassMaterial));

    
    linesMaterial = new THREE.ShaderMaterial({
        vertexShader: linev,
        fragmentShader: linef,
        uniforms: {
            uTime: { value: 0 },
            uRandom: { value: 0 },
            uRandomVec4: new THREE.Uniform(new THREE.Vector4(0, 0, 0, 0)),
            uFocalDepth: { value: cameraFocalDistance },
            uBokehStrength: { value: bokehStrength },
            uMinimumLineSize: { value: minimumLineSize },
            uFocalPowerFunction: { value: focalPowerFunction },
            uBokehTexture: { type: "t", value: new THREE.TextureLoader().load(bokehTexturePath) },
            uDistanceAttenuation: { value: distanceAttenuation }, 
        },

        defines: {
            USE_BOKEH_TEXTURE: (useBokehTexture ? 1 : 0)
        },

        side:           THREE.DoubleSide,
        depthTest:      false,

        blending:      THREE.CustomBlending,
        blendEquation: THREE.AddEquation,
        blendSrc:      THREE.OneFactor, 
        blendSrcAlpha: THREE.OneFactor,
        blendDst:      THREE.OneFactor, 
        blendDstAlpha: THREE.OneFactor,  
    });

    quadsMaterial = new THREE.ShaderMaterial({
        vertexShader: quadv,
        fragmentShader: quadf,
        uniforms: {
            uTexture: { type: "t",   value: new THREE.TextureLoader().load(quadsTexturePath) },
            uTime: { value: 0 },
            uRandom: { value: 0 },
            uRandomVec4: new THREE.Uniform(new THREE.Vector4(0, 0, 0, 0)),
            uFocalDepth: { value: cameraFocalDistance },
            uBokehStrength: { value: bokehStrength },
            uMinimumLineSize: { value: minimumLineSize },
            uFocalPowerFunction: { value: focalPowerFunction },
            uBokehTexture: { type: "t", value: new THREE.TextureLoader().load(bokehTexturePath) },
            uDistanceAttenuation: { value: distanceAttenuation }, 
        },

        defines: {
            USE_BOKEH_TEXTURE: (useBokehTexture ? 1 : 0)
        },

        side:           THREE.DoubleSide,
        depthTest:      false,

        blending:      THREE.CustomBlending,
        blendEquation: THREE.AddEquation,
        blendSrc:      THREE.OneFactor, 
        blendSrcAlpha: THREE.OneFactor,
        blendDst:      THREE.OneFactor, 
        blendDstAlpha: THREE.OneFactor,  
    });


    createLinesWrapper(frames / motionBlurFrames);


    buildControls();
    render();
}  

// Message utility: creates animated transient messages in the corner of the page.
function showMessage(text, options) {
    options = options || {};
    var duration = options.duration || 3000;
    var type = options.type || 'default';
    var container = document.getElementById('messages');
    if(!container) return;

    var el = document.createElement('div');
    el.className = 'message';

    // support passing a message object { text, type, duration }
    if(typeof text === 'object' && text !== null) {
        var msgObj = text;
        el.textContent = msgObj.text || '';
        if(msgObj.type) type = msgObj.type;
        if(msgObj.duration) duration = msgObj.duration;
        if(msgObj.anim) options.anim = msgObj.anim;
    } else {
        el.textContent = text;
    }

    // add type class
    if(type && type !== 'default') el.classList.add(type);

    container.appendChild(el);

    // force reflow then show
    void el.offsetWidth;
    // handle word-by-word animation if requested
    var anim = options.anim || null;
    var revealIntervalId = null;
    if(anim === 'word') {
        el.textContent = '';
        var fullText = (typeof text === 'object' && text !== null) ? (text.text || '') : text;
        // split into tokens preserving whitespace (so newlines stay intact)
        var tokens = fullText.split(/(\s+)/).filter(function(t){ return t.length > 0; });
        var wordsCount = Math.max(tokens.length, 1);
        // allocate up to 45% of duration to reveal phase, but not too fast
        var revealTime = Math.min(duration * 0.45, wordsCount * 140);
        var interval = revealTime / wordsCount;
        var idx = 0;
        el.classList.add('show');
        revealIntervalId = setInterval(function(){
            if(idx >= wordsCount) {
                clearInterval(revealIntervalId);
                revealIntervalId = null;
                return;
            }
            // append next token exactly (preserves spaces/newlines)
            el.textContent += tokens[idx];
            idx++;
        }, interval);
    } else {
        el.classList.add('show');
    }

    // hide after duration
    var hideTimeout = setTimeout(function(){
        if(revealIntervalId) { clearInterval(revealIntervalId); revealIntervalId = null; }
        el.classList.remove('show');
        el.classList.add('hide');
        // remove after animation
        setTimeout(function(){
            if(el && el.parentNode) el.parentNode.removeChild(el);
        }, 420);
    }, duration);

    // return a function to dismiss early
    return function dismiss() {
        clearTimeout(hideTimeout);
        if(revealIntervalId) { clearInterval(revealIntervalId); revealIntervalId = null; }
        if(el && el.parentNode) {
            el.classList.remove('show');
            el.classList.add('hide');
            setTimeout(function(){ if(el.parentNode) el.parentNode.removeChild(el); }, 420);
        }
    };
}

// expose globally
window.showMessage = showMessage;

// show a sample message on load (effects started)
// Show a sequence of messages one-by-one with animation
function showMessageSequence(messages, options) {
    options = options || {};
    var duration = options.duration || 3500;
    var gap = options.gap || 500;

    var i = 0;
    function next() {
        if(i >= messages.length) return;

        var msg = messages[i];
        // first two messages use default animation; subsequent messages use word-by-word reveal
        if(i < 2) {
            // preserve object messages
            if(typeof msg === 'object' && msg !== null) {
                // ensure duration if not set
                msg.duration = msg.duration || duration;
                showMessage(msg, { duration: msg.duration, type: msg.type });
            } else {
                showMessage(msg, { duration: duration });
            }
        } else {
            // force word animation for later messages
            if(typeof msg === 'object' && msg !== null) {
                msg.anim = msg.anim || 'word';
                msg.duration = msg.duration || duration;
                showMessage(msg, { duration: msg.duration, type: msg.type, anim: msg.anim });
            } else {
                showMessage({ text: msg, anim: 'word' }, { duration: duration, anim: 'word' });
            }
        }

        i++;
        setTimeout(next, duration + gap);
    }

    // small initial delay so the scene feels ready
    setTimeout(next, options.startDelay || 600);
}

window.addEventListener('load', function(){
    var msgs = [
        'Finally the wait is over…',
        'Move your finger anywhere you want on your screen to see the magic',
        'Hope your birthday is as amazing as you are.',
        'Wishing you a year full of joy, laughter, and everything you love.',
        'May all your wishes come true—today and every day.',
        'Thanks for being my friend—even when I act like I\'m from another planet.',
        'Sorry for not being there.'
    ];

    showMessageSequence(msgs, { duration: 3800, gap: 550, startDelay: 800 });
});


let lastFrameDate = 0;
function render(now) {
    requestAnimationFrame(render);

    // autoplay orbit: runs when enabled and not paused by recent user interaction
    if(autoRotateEnabled && !autoplayPause && initialCameraPos) {
        // compute time in seconds
        let t = now * 0.001;

        // randomized angle: base linear rotation + a couple of slow oscillations for unpredictability
        let baseAngle = t * autoplayBaseSpeed
                        + Math.sin(t * 0.6 + autoplaySeed * 0.01) * 0.6
                        + Math.cos(t * 0.37 + autoplaySeed * 0.021) * 0.3;
        let angle = baseAngle + autoplayPhaseOffset;

        // use autoplayBaseRadius (updated on resume) and vary it slowly
        let baseRadius = autoplayBaseRadius !== null ? autoplayBaseRadius : initialCameraPos.clone().sub(controls.target).length();
        let radius = baseRadius * (1.0 + 0.06 * Math.sin(t * 0.7 + autoplaySeed));

        camera.position.x = controls.target.x + radius * Math.cos(angle);
        camera.position.z = controls.target.z + radius * Math.sin(angle);
        // vertical bob centered around autoplayBaseY
        let baseY = autoplayBaseY !== null ? autoplayBaseY : initialCameraPos.y;
        camera.position.y = baseY + Math.sin(t * 0.4 + autoplaySeed * 0.5) * 2.0;
        camera.lookAt(controls.target);
    }

    checkControls();



    if(!capturerStarted) {
        capturerStarted = true;
    }

    controls.update();


    for(let i = 0; i < drawCallsPerFrame; i++) {
        samples++;
        linesMaterial.uniforms.uBokehStrength.value = bokehStrength;
        linesMaterial.uniforms.uFocalDepth.value = cameraFocalDistance;
        linesMaterial.uniforms.uFocalPowerFunction.value = focalPowerFunction;
        linesMaterial.uniforms.uMinimumLineSize.value = minimumLineSize;
        linesMaterial.uniforms.uRandom.value = Math.random() * 1000;
        linesMaterial.uniforms.uTime.value = (now * 0.001) % 100;   // modulating time by 100 since it appears hash12 suffers with higher time values
        linesMaterial.uniforms.uRandomVec4.value = new THREE.Vector4(Math.random() * 100, Math.random() * 100, Math.random() * 100, Math.random() * 100);
        linesMaterial.uniforms.uDistanceAttenuation.value = distanceAttenuation;

        quadsMaterial.uniforms.uBokehStrength.value = bokehStrength;
        quadsMaterial.uniforms.uFocalDepth.value = cameraFocalDistance;
        quadsMaterial.uniforms.uFocalPowerFunction.value = focalPowerFunction;
        quadsMaterial.uniforms.uMinimumLineSize.value = minimumLineSize;
        quadsMaterial.uniforms.uRandom.value = Math.random() * 1000;
        quadsMaterial.uniforms.uTime.value = (now * 0.001) % 100;   // modulating time by 100 since it appears hash12 suffers with higher time values
        quadsMaterial.uniforms.uRandomVec4.value = new THREE.Vector4(Math.random() * 100, Math.random() * 100, Math.random() * 100, Math.random() * 100);
        quadsMaterial.uniforms.uDistanceAttenuation.value = distanceAttenuation;

        renderer.render(scene, camera, offscreenRT);
    }
   
    if(shaderpassf !== "") {
        shaderPassMaterial.uniforms.uTime.value = (now * 0.001) % 1000;
        shaderPassMaterial.uniforms.uRandoms.value = new THREE.Vector4(Math.random(), Math.random(), Math.random(), Math.random());
        shaderPassMaterial.uniforms.uCameraPosition.value = new THREE.Vector3(camera.position.x, camera.position.y, camera.position.z);
        shaderPassMaterial.uniforms.uBokehStrength.value = bokehStrength;
        renderer.render(shaderPassScene, postProcCamera, offscreenRT);    
    }

    postProcQuadMaterial.uniforms.uSamples.value  = samples;
    postProcQuadMaterial.uniforms.uExposure.value = exposure;
    postProcQuadMaterial.uniforms.uCameraPosition.value = new THREE.Vector3(camera.position.x, camera.position.y, camera.position.z);
    renderer.render(postProcScene, postProcCamera);


    // used to make GIF animations
    if(lastFrameDate + millisecondsPerFrame < Date.now()) {
        frames++;
        createLinesWrapper(frames / motionBlurFrames);

        if(frames % motionBlurFrames === 0) {
            resetCanvas();

            if(captureFrames) {
                var photo = canvas.toDataURL('image/jpeg');                
                $.ajax({
                    method: 'POST',
                    url: 'photo_upload.php',
                    data: {
                        photo: photo
                    }
                });
            }
        }

        lastFrameDate = Date.now();

        if(frames === (framesCount * motionBlurFrames)) {
            lastFrameDate = Infinity;
            frames = 0;
        }
    }
}

function onWindowResize() {
    var w = window.innerWidth;
    var h = window.innerHeight;

    // update renderer size and pixel ratio
    renderer.setPixelRatio( Math.min(window.devicePixelRatio || 1, 2) );
    renderer.setSize(w, h);

    // update main camera
    if(camera) {
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
    }

    // update post-process camera
    if(postProcCamera) {
        postProcCamera.aspect = w / h;
        postProcCamera.updateProjectionMatrix();
    }

    // update render target size
    if(offscreenRT) {
        if(offscreenRT.setSize) {
            offscreenRT.setSize(w, h);
        }
    }

    // update shader uniforms that depend on resolution
    try {
        if(shaderPassMaterial && shaderPassMaterial.uniforms && shaderPassMaterial.uniforms.uResolution) {
            shaderPassMaterial.uniforms.uResolution.value.set(w, h);
        }
    } catch(e) { }

    try {
        if(postProcQuadMaterial && postProcQuadMaterial.uniforms && postProcQuadMaterial.uniforms.uResolution) {
            postProcQuadMaterial.uniforms.uResolution.value.set(w, h);
        }
    } catch(e) { }

    // reset sample accumulation when size changes
    samples = 0;
}


function resetCanvas() {
    scene.background = new THREE.Color(0x000000);
    renderer.render(scene, camera, offscreenRT);
    samples = 0;
    scene.background = null;
}

function createLinesWrapper(frames) {
    // ***************** lines creation 
    lines = [];
    scene.remove(scene.getObjectByName("points"));

    quads = [];
    scene.remove(scene.getObjectByName("quad-points"));




    createScene(frames);



    // ***************** lines creation
    createLinesGeometry();
    let mesh = new THREE.Points(linesGeometry, linesMaterial);
    mesh.name = "points";

    scene.add(mesh);
    // ***************** lines creation - END



    // ***************** quads creation 
    createQuadsGeometry();
    let quadmesh = new THREE.Points(quadsGeometry, quadsMaterial);
    quadmesh.name = "quad-points";

    scene.add(quadmesh);
    // ***************** quads creation - END

}

function createLinesGeometry() {

    var geometry  = new THREE.BufferGeometry();
    var position1 = [];
    var position2 = [];
    var color1    = [];
    var color2    = [];
    var seed      = [];



    let accumulatedLinesLength = 0;
    for(let i = 0; i < lines.length; i++) {
        let line = lines[i];

        let lx1 = line.x1; 
        let ly1 = line.y1;
        let lz1 = line.z1;
    
        let lx2 = line.x2; 
        let ly2 = line.y2;
        let lz2 = line.z2;

        let weight = line.weight || 1;
    
        let dx = lx1 - lx2;
        let dy = ly1 - ly2;
        let dz = lz1 - lz2;
        let lineLength = Math.sqrt(dx*dx + dy*dy + dz*dz) * weight;

        accumulatedLinesLength += lineLength;
    }
    let pointsPerUnit = pointsPerFrame / accumulatedLinesLength;




    for(let j = 0; j < lines.length; j++) {

        let line = lines[j];

        let lx1 = line.x1; 
        let ly1 = line.y1;
        let lz1 = line.z1;
    
        let lx2 = line.x2; 
        let ly2 = line.y2;
        let lz2 = line.z2;

        let weight = line.weight || 1;

    
        // how many points per line?
        let points = pointsPerLine;
        let invPointsPerLine = 1 / points;

        if(useLengthSampling) {
            let dx = lx1 - lx2;
            let dy = ly1 - ly2;
            let dz = lz1 - lz2;
            let lineLength = Math.sqrt(dx*dx + dy*dy + dz*dz);

            points = Math.max(  Math.floor(pointsPerUnit * lineLength * weight), 1  );
            invPointsPerLine = 1 / points;
        }

        for(let ppr = 0; ppr < points; ppr++) {
            position1.push(lx1, ly1, lz1);
            position2.push(lx2, ly2, lz2);
            color1.push(line.c1r * invPointsPerLine, line.c1g * invPointsPerLine, line.c1b * invPointsPerLine);
            color2.push(line.c2r * invPointsPerLine, line.c2g * invPointsPerLine, line.c2b * invPointsPerLine)    
            
            seed.push(Math.random() * 100, Math.random() * 100, Math.random() * 100, Math.random() * 100);    
        }
    }

 
    geometry.addAttribute( 'position',  new THREE.BufferAttribute( new Float32Array(position1), 3 ) );
    geometry.addAttribute( 'position1', new THREE.BufferAttribute( new Float32Array(position2), 3 ) );
    geometry.addAttribute( 'color1',    new THREE.BufferAttribute( new Float32Array(color1), 3 ) );
    geometry.addAttribute( 'color2',    new THREE.BufferAttribute( new Float32Array(color2), 3 ) );
    geometry.addAttribute( 'aSeed',     new THREE.BufferAttribute( new Float32Array(seed), 4 ) );
    
    linesGeometry = geometry;
} 

function createQuadsGeometry() {

    var geometry  = new THREE.BufferGeometry();
    var position1 = [];
    var position2 = [];
    var position3 = [];
    var uv1 = [];
    var uv2 = [];
    var color     = [];
    var seeds     = [];

    let accumulatedQuadsArea = 0;
    for(let i = 0; i < quads.length; i++) {
        let quad = quads[i];

        let lx1 = quad.v1.x; 
        let ly1 = quad.v1.y;
        let lz1 = quad.v1.z;
    
        let lx2 = quad.v2.x; 
        let ly2 = quad.v2.y;
        let lz2 = quad.v2.z;

        let weight = quad.weight || 1;
    
        let dx = lx1 - lx2;
        let dy = ly1 - ly2;
        let dz = lz1 - lz2;
        let sideLength = Math.sqrt(dx*dx + dy*dy + dz*dz);
        let areaLength = (sideLength * sideLength) * weight;

        accumulatedQuadsArea += areaLength;
    }
    let pointsPerUnitArea = quadPointsPerFrame / accumulatedQuadsArea;

    for(let j = 0; j < quads.length; j++) {

        let quad = quads[j];

        let lx1 = quad.v1.x; 
        let ly1 = quad.v1.y;
        let lz1 = quad.v1.z;
    
        let lx2 = quad.v2.x; 
        let ly2 = quad.v2.y;
        let lz2 = quad.v2.z;

        let lx3 = quad.v3.x; 
        let ly3 = quad.v3.y;
        let lz3 = quad.v3.z;

        let weight = quad.weight || 1;

        if(j === 829) {
            let debug = 0;
        }

        let u1 = quad.uv1.x;
        let v1 = quad.uv1.y;

        let u2 = quad.uv2.x;
        let v2 = quad.uv2.y;

    
        let points = pointsPerQuad;
        let invPointsPerQuad = 1 / points;

        if(useLengthSampling) {
            let dx = lx1 - lx2;
            let dy = ly1 - ly2;
            let dz = lz1 - lz2;
            let sideLength = Math.sqrt(dx*dx + dy*dy + dz*dz);
            let areaLength = (sideLength * sideLength);

            points = Math.max(  Math.floor(pointsPerUnitArea * areaLength * weight), 1  );
            invPointsPerQuad = 1 / points;
        }


        for(let ppr = 0; ppr < points; ppr++) {
            position1.push(lx1, ly1, lz1);
            position2.push(lx2, ly2, lz2);
            position3.push(lx3, ly3, lz3);
            uv1.push(u1, v1);
            uv2.push(u2, v2);
            color.push(quad.col.x * invPointsPerQuad, quad.col.y * invPointsPerQuad, quad.col.z * invPointsPerQuad);

            seeds.push(Math.random() * 100, Math.random() * 100, Math.random() * 100, Math.random() * 100);    
        }
    }
 
    geometry.addAttribute( 'position',  new THREE.BufferAttribute( new Float32Array(position1), 3 ) );
    geometry.addAttribute( 'position1', new THREE.BufferAttribute( new Float32Array(position2), 3 ) );
    geometry.addAttribute( 'position2', new THREE.BufferAttribute( new Float32Array(position3), 3 ) );
    geometry.addAttribute( 'uv1',       new THREE.BufferAttribute( new Float32Array(uv1),       2 ) );
    geometry.addAttribute( 'uv2',       new THREE.BufferAttribute( new Float32Array(uv2),       2 ) );
    geometry.addAttribute( 'color',     new THREE.BufferAttribute( new Float32Array(color),     3 ) );
    geometry.addAttribute( 'aSeeds',    new THREE.BufferAttribute( new Float32Array(seeds),     4 ) );
    
    quadsGeometry = geometry;
} 


function buildControls() {
    window.addEventListener("keydown", function(e) {
        controls[e.key] = true;
    });

    window.addEventListener("keyup", function(e) {
        controls[e.key] = false;
    });


    window.addEventListener("keypress", function(e) {
        if(e.key == "h" || e.key == "H") {
            document.querySelector(".controls").classList.toggle("active");
        }
        if(e.key == "m" || e.key == "M") {
            if(focalPowerFunction === 0) focalPowerFunction = 1;
            else                         focalPowerFunction = 0;

            resetCanvas();
        }

        if(e.key == "5") {
            // if(layout) {
            //     cameraFocalDistance = 99; //88; // dv.length();
            //     bokehStrength = 0.1; //0.01;
            // } else {
            //     cameraFocalDistance = 88.2; //88; // dv.length();
            //     bokehStrength = 0.012; //0.01;
            // }

            // layout = !layout;

            // resetCanvas();
        }
    });
}

function checkControls() {
    if(controls["o"]) {
        cameraFocalDistance -= 0.6;
        console.log("cfd: " + cameraFocalDistance);
        resetCanvas();
    }
    if(controls["p"]) {
        cameraFocalDistance += 0.6;        
        console.log("cfd: " + cameraFocalDistance);
        resetCanvas();
    }
    
    if(controls["k"]) {
        bokehStrength += 0.001;
        console.log("bs: " + bokehStrength);
        resetCanvas();    
    }
    if(controls["l"]) {
        bokehStrength -= 0.001;        
        bokehStrength = Math.max(bokehStrength, 0);        
        console.log("bs: " + bokehStrength);
        resetCanvas();
    }

    if(controls["n"]) {
        bokehFalloff += 3.5;
        console.log("bf: " + bokehFalloff);
    }
    if(controls["m"]) {
        bokehFalloff -= 3.5;        
        console.log("bf: " + bokehFalloff);
    }

    if(controls["v"]) {
        exposure += 0.0001;
        console.log("exp: " + exposure);
    }
    if(controls["b"]) {
        exposure -= 0.0001;
        exposure = Math.max(exposure, 0.0001);
        console.log("exp: " + exposure);
    }

    if(controls["u"]) {
        distanceAttenuation += 0.003;
        console.log("da: " + distanceAttenuation);
        resetCanvas();
    }
    if(controls["i"]) {
        distanceAttenuation -= 0.003;
        distanceAttenuation = Math.max(distanceAttenuation, 0);
        console.log("da: " + distanceAttenuation);
        resetCanvas();
    }
}