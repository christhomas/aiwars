// Game Constants
let canvasWidth = 800;
let canvasHeight = 600;
const WALL_THICKNESS = 20; // Arena wall thickness (pixels)
const TANK_SIZE = 30; // Tank body size (pixels)
const TANK_SPEED = 3; // Tank movement speed (pixels per frame)
const BULLET_SPEED = 8; // Bullet movement speed (pixels per frame)
const BULLET_SIZE = 6; // Bullet radius/size used for collision + drawing (pixels)
const DEFAULT_MAX_HEALTH = 100; // Default starting HP per tank
const DAMAGE_PER_HIT = 10; // Bullet damage dealt per hit (HP)
const ROTATION_SPEED = 4.5; // Tank rotation speed during random turning (degrees per frame)
const GRID_CELL_SIZE = 60; // Spatial grid cell size for broadphase collision (pixels)
const FIRE_INTERVAL = 60; // Frames between shots while moving (~1 second at 60fps)
const DEFAULT_PREDATOR_CHANCE = 0.15; // Default chance for a tank to start as a predator
const RADAR_RANGE = 200; // Predator radar range (pixels)
const PREDATOR_TURN_SPEED = 6; // Predator turn speed when steering toward targets (degrees per frame)
const RADAR_SWEEP_SPEED = 3; // Degrees per frame for radar sweep
const RADAR_SWEEP_ANGLE = 60; // Total sweep angle (±30 degrees from center)
const DEFAULT_MISSILE_CHANCE = 0.15; // 15% chance for missile ability
const MISSILE_SPEED = 6; // Missile movement speed (pixels per frame)
const MISSILE_TURN_SPEED = 5; // Missile turn speed (degrees per frame)
const MISSILE_SEEK_RANGE = 400; // Missile homing seek radius (pixels)
const MISSILE_FIRE_INTERVAL = 90; // Missile cooldown (frames)

// Power-up tuning
const POWERUP_SIZE = 14; // Power-up pickup radius (pixels)
const POWERUP_SPAWN_INTERVAL_MS = 1000; // Spawn cadence (milliseconds)
const MAX_POWERUPS = 100; // Max number of power-ups allowed on the map at once
const POWERUP_HEAL_FRACTION = 0.5; // Heal amount as a fraction of maxHealth (e.g. 0.5 = +50% max HP)

// Power-up timeouts: how long each power-up stays on the ground before disappearing (milliseconds)
const POWERUP_GROUND_LIFETIME_HEAL_MS = 30000; // heal
const POWERUP_GROUND_LIFETIME_SHIELD_MS = 30000; // shield
const POWERUP_GROUND_LIFETIME_SPEED_MS = 30000; // speed
const POWERUP_GROUND_LIFETIME_ROCKET_MS = 30000; // rocket
const POWERUP_GROUND_LIFETIME_PREDATOR_MS = 30000; // predator
const POWERUP_GROUND_LIFETIME_DOUBLER_MS = 60000; // doubler

// Power-up spawn weights: relative chance of spawning each type when a power-up spawns
// Example: heal=2 and others=1 means heal is ~2x as likely as each other type.
const POWERUP_WEIGHT_HEAL = 1;
const POWERUP_WEIGHT_SHIELD = 1;
const POWERUP_WEIGHT_SPEED = 1;
const POWERUP_WEIGHT_ROCKET = 1;
const POWERUP_WEIGHT_PREDATOR = 1;
const POWERUP_WEIGHT_DOUBLER = 1;

// Power-up effect durations (milliseconds)
const SHIELD_DURATION_MS = 30000; // How long the shield lasts after pickup
const SPEED_DURATION_MS = 30000; // How long the speed boost lasts after pickup
const SPEED_MULTIPLIER = 2; // Movement multiplier while speed boost is active

// Game state
let canvas, ctx, canvasWrapper;
let tanks = [];
let bullets = [];
let explosions = [];
let gameRunning = true;
let paused = false;
let winner = null;
let numTanks = 6;
let frameCount = 0;
let nowMs = 0;
let nextPowerUpSpawnMs = 0;

let gameMode = 'random';

let nextTankId = 0;

let predatorChance = DEFAULT_PREDATOR_CHANCE;
let missileChance = DEFAULT_MISSILE_CHANCE;
let maxHealth = DEFAULT_MAX_HEALTH;

// Spatial partitioning grid
let spatialGrid = {};
let gridCols = 0;
let gridRows = 0;

// Pre-rendered assets
let arenaCanvas, arenaCtx;
let tankCanvasCache = new Map(); // Cache pre-rendered tank sprites

// Object pools
const bulletPool = [];
const explosionPool = [];
const particlePool = [];
const fireRingPool = [];
const blessingRingPool = [];
const missilePool = [];
const powerUpPool = [];
const shieldPingPool = [];

// Fire rings from tank deaths
let fireRings = [];
let blessingRings = [];
let missiles = [];
let powerUps = [];
let shieldPings = [];

// Pre-computed values
const DEG_TO_RAD = Math.PI / 180;
const sinTable = new Float32Array(360);
const cosTable = new Float32Array(360);

// Initialize lookup tables
for (let i = 0; i < 360; i++) {
    sinTable[i] = Math.sin((i - 90) * DEG_TO_RAD);
    cosTable[i] = Math.cos((i - 90) * DEG_TO_RAD);
}

class BlessingRing {
    constructor(x, y) {
        this.reset(x, y);
    }

    reset(x, y) {
        this.x = x;
        this.y = y;
        this.radius = 8;
        this.expandSpeed = 10;
        this.thickness = 16;
        this.active = true;
        this.opacity = 1;
        const maxDistX = Math.max(x, canvasWidth - x);
        const maxDistY = Math.max(y, canvasHeight - y);
        this.maxRadius = Math.sqrt(maxDistX * maxDistX + maxDistY * maxDistY) + 50;
    }

    update() {
        if (!this.active) return;

        this.radius += this.expandSpeed;
        this.thickness = Math.max(4, 16 - this.radius * 0.02);
        this.opacity = Math.max(0, 1 - (this.radius / this.maxRadius));

        if (this.radius > this.maxRadius) {
            this.active = false;
        }
    }

    draw() {
        if (!this.active || this.opacity <= 0) return;

        const x = this.x | 0;
        const y = this.y | 0;

        ctx.save();
        ctx.globalAlpha = this.opacity;

        // Outer glow
        ctx.beginPath();
        ctx.arc(x, y, this.radius + this.thickness, 0, Math.PI * 2);
        ctx.arc(x, y, Math.max(0, this.radius - this.thickness), 0, Math.PI * 2, true);
        ctx.fillStyle = `rgba(255, 255, 255, ${this.opacity * 0.35})`;
        ctx.fill();

        // Main ring
        ctx.beginPath();
        ctx.arc(x, y, this.radius, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255, 255, 255, ${this.opacity})`;
        ctx.lineWidth = this.thickness;
        ctx.stroke();

        ctx.restore();
    }
}

function findSpawnPosition() {
    const margin = WALL_THICKNESS + TANK_SIZE;
    const minDist = TANK_SIZE * 1.1;
    const minDistSq = minDist * minDist;
    const maxAttempts = 200;

    for (let attempts = 0; attempts < maxAttempts; attempts++) {
        const x = margin + Math.random() * (canvasWidth - 2 * margin);
        const y = margin + Math.random() * (canvasHeight - 2 * margin);

        let ok = true;
        for (let i = 0; i < tanks.length; i++) {
            if (tanks[i].state === TankState.DEAD) continue;
            const dx = x - tanks[i].x;
            const dy = y - tanks[i].y;
            if (dx * dx + dy * dy < minDistSq) {
                ok = false;
                break;
            }
        }

        if (ok) return { x, y };
    }

    return {
        x: margin + Math.random() * (canvasWidth - 2 * margin),
        y: margin + Math.random() * (canvasHeight - 2 * margin)
    };
}

function findSpawnPositionNear(originX, originY) {
    const margin = WALL_THICKNESS + TANK_SIZE;
    const minDist = TANK_SIZE * 1.1;
    const minDistSq = minDist * minDist;
    const maxAttempts = 80;

    for (let attempts = 0; attempts < maxAttempts; attempts++) {
        const a = Math.random() * Math.PI * 2;
        const r = (TANK_SIZE * 2.2) + Math.random() * (TANK_SIZE * 2.8);
        const x = originX + Math.cos(a) * r;
        const y = originY + Math.sin(a) * r;

        if (x < margin || x > canvasWidth - margin || y < margin || y > canvasHeight - margin) continue;

        let ok = true;
        for (let i = 0; i < tanks.length; i++) {
            if (tanks[i].state === TankState.DEAD) continue;
            const dx = x - tanks[i].x;
            const dy = y - tanks[i].y;
            if (dx * dx + dy * dy < minDistSq) {
                ok = false;
                break;
            }
        }

        if (ok) return { x, y };
    }

    return null;
}

function spawnExtraTank(team, baseAngle, originX, originY) {
    const near = (typeof originX === 'number' && typeof originY === 'number')
        ? findSpawnPositionNear(originX, originY)
        : null;
    const pos = near || findSpawnPosition();
    const id = nextTankId++;
    const tank = new Tank(pos.x, pos.y, generateTankColor(id), id);

    if (typeof baseAngle === 'number') {
        tank.angle = ((baseAngle + 60) % 360) | 0;
    }

    if (gameMode === 'teams') {
        tank.team = team === 'blue' ? 'blue' : 'red';
        tank.colorObj = tank.team === 'red'
            ? { hex: '#ff3b3b', r: 255, g: 59, b: 59 }
            : { hex: '#2f80ff', r: 47, g: 128, b: 255 };
        tank.color = tank.colorObj.hex;
        tank.sprite = getTankSprite(tank.colorObj);
    }

    tanks.push(tank);
    numTanks = tanks.length;
}

class ShieldPing {
    constructor(x, y, baseRadius) {
        this.reset(x, y, baseRadius);
    }

    reset(x, y, baseRadius) {
        this.x = x;
        this.y = y;
        this.r = baseRadius;
        this.life = 1;
        this.active = true;
    }

    update() {
        if (!this.active) return;
        this.r += 3.5;
        this.life -= 0.08;
        if (this.life <= 0) this.active = false;
    }

    draw() {
        if (!this.active) return;
        ctx.beginPath();
        ctx.arc(this.x | 0, this.y | 0, this.r, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(255, 255, 255, ${this.life})`;
        ctx.lineWidth = 3;
        ctx.stroke();
    }
}

function spawnShieldPing(tank) {
    const baseRadius = tank.size * 2;
    let ping = shieldPingPool.pop();
    if (ping) ping.reset(tank.x, tank.y, baseRadius);
    else ping = new ShieldPing(tank.x, tank.y, baseRadius);
    shieldPings.push(ping);
}

function fastSin(angle) {
    const idx = ((angle % 360) + 360) % 360 | 0;
    return sinTable[idx];
}

function fastCos(angle) {
    const idx = ((angle % 360) + 360) % 360 | 0;
    return cosTable[idx];
}

// Tank states
const TankState = {
    MOVING: 0,
    ROTATING: 1,
    FIRING: 2,
    DEAD: 3
};

// Generate a vibrant color based on index using golden ratio
function generateTankColor(index) {
    const goldenRatio = 0.618033988749895;
    const hue = (index * goldenRatio * 360) % 360;
    const saturation = 70 + (index % 3) * 10;
    const lightness = 50 + (index % 4) * 5;
    return hslToRgb(hue, saturation, lightness);
}

// Convert HSL to RGB hex (pre-compute at tank creation)
function hslToRgb(h, s, l) {
    s /= 100;
    l /= 100;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs((h / 60) % 2 - 1));
    const m = l - c / 2;
    let r, g, b;

    if (h < 60) { r = c; g = x; b = 0; }
    else if (h < 120) { r = x; g = c; b = 0; }
    else if (h < 180) { r = 0; g = c; b = x; }
    else if (h < 240) { r = 0; g = x; b = c; }
    else if (h < 300) { r = x; g = 0; b = c; }
    else { r = c; g = 0; b = x; }

    const R = ((r + m) * 255) | 0;
    const G = ((g + m) * 255) | 0;
    const B = ((b + m) * 255) | 0;

    return {
        hex: `#${(R << 16 | G << 8 | B).toString(16).padStart(6, '0')}`,
        r: R, g: G, b: B
    };
}

// Darken color using pre-computed RGB values
function darkenColor(colorObj, amount) {
    const r = Math.max(0, colorObj.r - amount);
    const g = Math.max(0, colorObj.g - amount);
    const b = Math.max(0, colorObj.b - amount);
    return `rgb(${r},${g},${b})`;
}

class PowerUp {
    constructor(x, y, type) {
        this.reset(x, y, type);
    }

    reset(x, y, type) {
        this.x = x;
        this.y = y;
        this.type = type;
        this.active = true;
        let lifetimeMs = POWERUP_GROUND_LIFETIME_HEAL_MS;
        if (type === 'shield') lifetimeMs = POWERUP_GROUND_LIFETIME_SHIELD_MS;
        else if (type === 'speed') lifetimeMs = POWERUP_GROUND_LIFETIME_SPEED_MS;
        else if (type === 'rocket') lifetimeMs = POWERUP_GROUND_LIFETIME_ROCKET_MS;
        else if (type === 'predator') lifetimeMs = POWERUP_GROUND_LIFETIME_PREDATOR_MS;
        else if (type === 'doubler') lifetimeMs = POWERUP_GROUND_LIFETIME_DOUBLER_MS;
        this.expiresAtMs = nowMs + lifetimeMs;
    }

    draw() {
        if (!this.active) return;

        const x = this.x | 0;
        const y = this.y | 0;

        ctx.save();

        const hueCycle = 215 + 15 * Math.sin(frameCount * 0.05);
        const pulse = 0.5 + 0.5 * Math.sin(frameCount * 0.12);

        // Base circle
        ctx.beginPath();
        ctx.arc(x, y, POWERUP_SIZE, 0, Math.PI * 2);
        if (this.type === 'shield') {
            ctx.shadowBlur = 16 + 10 * pulse;
            ctx.shadowColor = `hsla(${hueCycle}, 100%, 55%, ${0.7 + 0.3 * pulse})`;
            ctx.fillStyle = `hsla(${hueCycle}, 100%, ${38 + 22 * pulse}%, 0.98)`;
        } else if (this.type === 'speed') {
            ctx.fillStyle = 'rgba(255, 215, 0, 0.95)';
        } else if (this.type === 'rocket') {
            ctx.fillStyle = 'rgba(155, 80, 255, 0.92)';
        } else if (this.type === 'predator') {
            ctx.fillStyle = 'rgba(255, 0, 255, 0.88)';
        } else if (this.type === 'doubler') {
            ctx.fillStyle = 'rgba(255, 255, 255, 0.85)';
        } else {
            ctx.fillStyle = 'rgba(0, 255, 120, 0.85)';
        }
        ctx.fill();

        // reset shadow so outline stays crisp
        ctx.shadowBlur = 0;

        ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.lineWidth = 2;
        ctx.stroke();

        if (this.type === 'shield') {
            // Shield icon
            ctx.font = 'bold 16px serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.shadowBlur = 10 + 8 * pulse;
            ctx.shadowColor = `hsla(${hueCycle}, 100%, 55%, ${0.6 + 0.4 * pulse})`;
            ctx.fillStyle = 'rgba(255, 255, 255, 0.98)';
            ctx.fillText('★', x, y + 1);
            ctx.shadowBlur = 0;
        } else if (this.type === 'speed') {
            ctx.beginPath();
            ctx.arc(x, y, POWERUP_SIZE * 0.45, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(0, 0, 0, 0.65)';
            ctx.lineWidth = 3;
            ctx.stroke();
        } else if (this.type === 'rocket') {
            ctx.font = '16px serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = 'rgba(255, 255, 255, 0.98)';
            ctx.fillText('🚀', x, y + 1);
        } else if (this.type === 'predator') {
            ctx.font = '16px serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = 'rgba(255, 255, 255, 0.98)';
            ctx.fillText('😈', x, y + 1);
        } else if (this.type === 'doubler') {
            ctx.font = '16px serif';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
            ctx.fillText('😇', x, y + 1);
        } else {
            // Cross
            ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
            const w = 4;
            const h = 10;
            ctx.fillRect(x - (w / 2), y - (h / 2), w, h);
            ctx.fillRect(x - (h / 2), y - (w / 2), h, w);
        }

        ctx.restore();
    }
}

function spawnPowerUp() {
    if (powerUps.length >= MAX_POWERUPS) return;

    const margin = WALL_THICKNESS + POWERUP_SIZE + 4;
    const x = margin + Math.random() * (canvasWidth - 2 * margin);
    const y = margin + Math.random() * (canvasHeight - 2 * margin);
    const totalWeight = POWERUP_WEIGHT_HEAL + POWERUP_WEIGHT_SHIELD + POWERUP_WEIGHT_SPEED + POWERUP_WEIGHT_ROCKET + POWERUP_WEIGHT_PREDATOR + POWERUP_WEIGHT_DOUBLER;
    let pick = Math.random() * totalWeight;
    let type;
    if ((pick -= POWERUP_WEIGHT_HEAL) < 0) type = 'heal';
    else if ((pick -= POWERUP_WEIGHT_SHIELD) < 0) type = 'shield';
    else if ((pick -= POWERUP_WEIGHT_SPEED) < 0) type = 'speed';
    else if ((pick -= POWERUP_WEIGHT_ROCKET) < 0) type = 'rocket';
    else if ((pick -= POWERUP_WEIGHT_PREDATOR) < 0) type = 'predator';
    else type = 'doubler';

    let p = powerUpPool.pop();
    if (p) p.reset(x, y, type);
    else p = new PowerUp(x, y, type);

    powerUps.push(p);
}

function updatePowerUpPickups() {
    if (powerUps.length === 0) return;

    const pickupRadius = (TANK_SIZE / 2 + POWERUP_SIZE);
    const pickupDistSq = pickupRadius * pickupRadius;

    for (let i = powerUps.length - 1; i >= 0; i--) {
        const p = powerUps[i];
        if (nowMs >= p.expiresAtMs) {
            p.active = false;
            powerUpPool.push(p);
            powerUps.splice(i, 1);
            continue;
        }

        let pickedUp = false;

        for (let t = 0; t < tanks.length; t++) {
            const tank = tanks[t];
            if (tank.state === TankState.DEAD) continue;

            const dx = tank.x - p.x;
            const dy = tank.y - p.y;
            if (dx * dx + dy * dy <= pickupDistSq) {
                if (p.type === 'shield') {
                    tank.shieldUntilMs = Math.max(tank.shieldUntilMs || 0, nowMs + SHIELD_DURATION_MS);
                } else if (p.type === 'speed') {
                    tank.speedUntilMs = Math.max(tank.speedUntilMs || 0, nowMs + SPEED_DURATION_MS);
                } else if (p.type === 'rocket') {
                    tank.hasMissiles = true;
                    tank.missileTimer = (Math.random() * MISSILE_FIRE_INTERVAL) | 0;
                } else if (p.type === 'predator') {
                    tank.isPredator = true;
                } else if (p.type === 'doubler') {
                    let ring = blessingRingPool.pop();
                    if (ring) ring.reset(tank.x, tank.y);
                    else ring = new BlessingRing(tank.x, tank.y);
                    blessingRings.push(ring);
                    spawnExtraTank(gameMode === 'teams' ? tank.team : null, tank.angle, tank.x, tank.y);
                } else {
                    const healAmount = Math.ceil(maxHealth * POWERUP_HEAL_FRACTION);
                    tank.health = Math.min(maxHealth, tank.health + healAmount);
                }
                pickedUp = true;
                break;
            }
        }

        if (pickedUp) {
            p.active = false;
            powerUpPool.push(p);
            powerUps.splice(i, 1);
        }
    }
}

// Spatial grid helpers
function getSpatialKey(x, y) {
    const col = (x / GRID_CELL_SIZE) | 0;
    const row = (y / GRID_CELL_SIZE) | 0;
    return col + row * gridCols;
}

function clearSpatialGrid() {
    spatialGrid = {};
}

function addToSpatialGrid(entity) {
    const key = getSpatialKey(entity.x, entity.y);
    if (!spatialGrid[key]) spatialGrid[key] = [];
    spatialGrid[key].push(entity);
}

function getNearbyEntities(x, y, radius) {
    const results = [];
    const minCol = Math.max(0, ((x - radius) / GRID_CELL_SIZE) | 0);
    const maxCol = Math.min(gridCols - 1, ((x + radius) / GRID_CELL_SIZE) | 0);
    const minRow = Math.max(0, ((y - radius) / GRID_CELL_SIZE) | 0);
    const maxRow = Math.min(gridRows - 1, ((y + radius) / GRID_CELL_SIZE) | 0);

    for (let row = minRow; row <= maxRow; row++) {
        for (let col = minCol; col <= maxCol; col++) {
            const key = col + row * gridCols;
            const cell = spatialGrid[key];
            if (cell) {
                for (let i = 0; i < cell.length; i++) {
                    results.push(cell[i]);
                }
            }
        }
    }
    return results;
}

// Pre-render tank sprite for a given color
function getTankSprite(colorObj) {
    const key = colorObj.hex;
    if (tankCanvasCache.has(key)) {
        return tankCanvasCache.get(key);
    }

    const size = TANK_SIZE + 30; // Extra space for barrel
    const spriteCanvas = document.createElement('canvas');
    spriteCanvas.width = size;
    spriteCanvas.height = size;
    const sctx = spriteCanvas.getContext('2d');

    const cx = size / 2;
    const cy = size / 2;

    // Tank body
    sctx.fillStyle = colorObj.hex;
    sctx.fillRect(cx - TANK_SIZE/2, cy - TANK_SIZE/2, TANK_SIZE, TANK_SIZE);

    // Tank outline
    sctx.strokeStyle = '#000';
    sctx.lineWidth = 2;
    sctx.strokeRect(cx - TANK_SIZE/2, cy - TANK_SIZE/2, TANK_SIZE, TANK_SIZE);

    // Tank turret/barrel
    sctx.fillStyle = darkenColor(colorObj, 30);
    sctx.fillRect(cx - 4, cy - TANK_SIZE/2 - 12, 8, 16);
    sctx.strokeRect(cx - 4, cy - TANK_SIZE/2 - 12, 8, 16);

    // Tank center detail
    sctx.beginPath();
    sctx.arc(cx, cy, 8, 0, Math.PI * 2);
    sctx.fillStyle = darkenColor(colorObj, 20);
    sctx.fill();
    sctx.stroke();

    tankCanvasCache.set(key, spriteCanvas);
    return spriteCanvas;
}

class Tank {
    constructor(x, y, colorObj, id) {
        this.id = id;
        this.x = x;
        this.y = y;
        this.colorObj = colorObj;
        this.color = colorObj.hex;
        this.team = null;
        this.angle = (Math.random() * 360) | 0;
        this.health = maxHealth;
        this.state = TankState.MOVING;
        this.rotationRemaining = 0;
        this.rotationDirection = 1;
        this.fireDelay = 0;
        this.size = TANK_SIZE;
        this.sprite = getTankSprite(colorObj);
        this.movingFireTimer = (Math.random() * FIRE_INTERVAL) | 0; // Stagger initial fire times

        // Predator properties
        this.isPredator = Math.random() < predatorChance;
        this.rainbowHue = Math.random() * 360;
        this.targetTank = null;
        this.radarPulse = 0;
        this.radarSweepAngle = 0; // Current sweep offset from tank angle
        this.radarSweepDirection = 1; // 1 = sweeping right, -1 = sweeping left

        // Missile properties
        this.hasMissiles = Math.random() < missileChance;
        this.missileTimer = (Math.random() * MISSILE_FIRE_INTERVAL) | 0;

        this.shieldUntilMs = 0;
        this.speedUntilMs = 0;
    }

    update() {
        if (this.state === TankState.DEAD) return;

        switch (this.state) {
            case TankState.MOVING:
                this.move();
                break;
            case TankState.ROTATING:
                this.rotate();
                break;
            case TankState.FIRING:
                this.fire();
                break;
        }
    }

    move() {
        // Predator hunting behavior
        if (this.isPredator) {
            this.rainbowHue = (this.rainbowHue + 3) % 360;
            this.radarPulse = (this.radarPulse + 0.1) % (Math.PI * 2);

            // Sweep radar left and right
            this.radarSweepAngle += RADAR_SWEEP_SPEED * this.radarSweepDirection;
            if (this.radarSweepAngle >= RADAR_SWEEP_ANGLE / 2) {
                this.radarSweepAngle = RADAR_SWEEP_ANGLE / 2;
                this.radarSweepDirection = -1;
            } else if (this.radarSweepAngle <= -RADAR_SWEEP_ANGLE / 2) {
                this.radarSweepAngle = -RADAR_SWEEP_ANGLE / 2;
                this.radarSweepDirection = 1;
            }

            // Prefer power-ups over enemy tanks when both are available
            let closestPowerUp = null;
            let closestDistSq = RADAR_RANGE * RADAR_RANGE;

            for (let i = 0; i < powerUps.length; i++) {
                const p = powerUps[i];
                const dx = p.x - this.x;
                const dy = p.y - this.y;
                const distSq = dx * dx + dy * dy;
                if (distSq < closestDistSq) {
                    closestDistSq = distSq;
                    closestPowerUp = p;
                }
            }

            const target = closestPowerUp ? null : this.findTargetWithRadar();
            if (closestPowerUp) {
                this.targetTank = null;

                const dx = closestPowerUp.x - this.x;
                const dy = closestPowerUp.y - this.y;
                let targetAngle = (Math.atan2(dy, dx) * 180 / Math.PI + 90 + 360) % 360;

                let angleDiff = targetAngle - this.angle;
                if (angleDiff > 180) angleDiff -= 360;
                if (angleDiff < -180) angleDiff += 360;

                if (Math.abs(angleDiff) > PREDATOR_TURN_SPEED) {
                    this.angle += angleDiff > 0 ? PREDATOR_TURN_SPEED : -PREDATOR_TURN_SPEED;
                    this.angle = (this.angle + 360) % 360 | 0;
                } else {
                    this.angle = targetAngle | 0;
                }
            } else if (target) {
                this.targetTank = target;
                // Calculate angle to target
                const dx = target.x - this.x;
                const dy = target.y - this.y;
                let targetAngle = (Math.atan2(dy, dx) * 180 / Math.PI + 90 + 360) % 360;

                // Calculate shortest rotation direction
                let angleDiff = targetAngle - this.angle;
                if (angleDiff > 180) angleDiff -= 360;
                if (angleDiff < -180) angleDiff += 360;

                // Turn toward target
                if (Math.abs(angleDiff) > PREDATOR_TURN_SPEED) {
                    this.angle += angleDiff > 0 ? PREDATOR_TURN_SPEED : -PREDATOR_TURN_SPEED;
                    this.angle = (this.angle + 360) % 360 | 0;
                } else {
                    this.angle = targetAngle | 0;
                }
            } else {
                this.targetTank = null;
            }
        }

        const cos = fastCos(this.angle);
        const sin = fastSin(this.angle);
        const speedMult = (this.speedUntilMs && nowMs < this.speedUntilMs) ? SPEED_MULTIPLIER : 1;
        const nextX = this.x + cos * TANK_SPEED * speedMult;
        const nextY = this.y + sin * TANK_SPEED * speedMult;

        if (this.checkWallCollision(nextX, nextY) || this.checkTankCollision(nextX, nextY)) {
            this.startRotation();
            return;
        }

        this.x = nextX;
        this.y = nextY;

        // Fire every second while moving
        if (--this.movingFireTimer <= 0) {
            this.shootBullet();
            this.movingFireTimer = FIRE_INTERVAL;
        }

        // Fire missiles if we have them
        if (this.hasMissiles && --this.missileTimer <= 0) {
            this.shootMissile();
            this.missileTimer = MISSILE_FIRE_INTERVAL;
        }
    }

    shootMissile() {
        const cos = fastCos(this.angle);
        const sin = fastSin(this.angle);
        const missileX = this.x + cos * (this.size / 2 + 5);
        const missileY = this.y + sin * (this.size / 2 + 5);

        let missile = missilePool.pop();
        if (missile) {
            missile.reset(missileX, missileY, this.angle, this.colorObj, this.id);
        } else {
            missile = new Missile(missileX, missileY, this.angle, this.colorObj, this.id);
        }

        if (gameMode === 'teams') {
            missile.ownerTeam = this.team;
            missile.targetMode = this.team === 'red' ? 'blue' : 'red';
        } else {
            missile.targetMode = 'random';
        }
        missiles.push(missile);
    }

    findTargetWithRadar() {
        // Calculate the current radar beam angle
        const radarAngle = (this.angle + this.radarSweepAngle + 360) % 360;
        const radarRad = (radarAngle - 90) * DEG_TO_RAD;
        const radarCos = Math.cos(radarRad);
        const radarSin = Math.sin(radarRad);

        const nearby = getNearbyEntities(this.x, this.y, RADAR_RANGE);
        let closestTarget = null;
        let closestDist = RADAR_RANGE;

        for (let i = 0; i < nearby.length; i++) {
            const tank = nearby[i];
            if (tank.id === this.id || tank.state === TankState.DEAD) continue;
            if (gameMode === 'teams' && this.team && tank.team === this.team) continue;

            const dx = tank.x - this.x;
            const dy = tank.y - this.y;
            const dist = Math.sqrt(dx * dx + dy * dy);

            if (dist > RADAR_RANGE) continue;

            // Check if tank is near the radar beam line (within ~15 degrees tolerance)
            const tankAngle = (Math.atan2(dy, dx) * 180 / Math.PI + 90 + 360) % 360;
            let angleDiff = Math.abs(tankAngle - radarAngle);
            if (angleDiff > 180) angleDiff = 360 - angleDiff;

            // Wider detection at closer range, narrower at far range
            const detectionAngle = 10 + (1 - dist / RADAR_RANGE) * 15;

            if (angleDiff <= detectionAngle && dist < closestDist) {
                closestDist = dist;
                closestTarget = tank;
            }
        }

        return closestTarget;
    }

    checkWallCollision(x, y) {
        const tankRadius = this.size * 0.55;
        const shieldRadius = (this.shieldUntilMs && nowMs < this.shieldUntilMs) ? this.size * 2 : 0;
        const halfSize = Math.max(tankRadius, shieldRadius);
        return (
            x - halfSize < WALL_THICKNESS ||
            x + halfSize > canvasWidth - WALL_THICKNESS ||
            y - halfSize < WALL_THICKNESS ||
            y + halfSize > canvasHeight - WALL_THICKNESS
        );
    }

    checkTankCollision(x, y) {
        const tankRadius = this.size * 0.55;
        const shieldRadius = (this.shieldUntilMs && nowMs < this.shieldUntilMs) ? this.size * 2 : 0;
        const thisRadius = Math.max(tankRadius, shieldRadius);
        const nearby = getNearbyEntities(x, y, thisRadius * 2);
        for (let i = 0; i < nearby.length; i++) {
            const tank = nearby[i];
            if (tank.id === this.id || tank.state === TankState.DEAD) continue;

            const dx = x - tank.x;
            const dy = y - tank.y;
            const distSq = dx * dx + dy * dy;
            const otherTankRadius = tank.size * 0.55;
            const otherShieldRadius = (tank.shieldUntilMs && nowMs < tank.shieldUntilMs) ? tank.size * 2 : 0;
            const otherRadius = Math.max(otherTankRadius, otherShieldRadius);
            const minDist = thisRadius + otherRadius;

            if (distSq < minDist * minDist) {
                return true;
            }
        }
        return false;
    }

    startRotation() {
        this.state = TankState.ROTATING;
        this.rotationDirection = Math.random() < 0.5 ? -1 : 1;
        this.rotationRemaining = 45 + Math.random() * 315;
    }

    rotate() {
        // Keep rainbow pulsing and radar sweeping for predators
        if (this.isPredator) {
            this.rainbowHue = (this.rainbowHue + 3) % 360;
            this.radarPulse = (this.radarPulse + 0.1) % (Math.PI * 2);

            // Keep radar sweeping
            this.radarSweepAngle += RADAR_SWEEP_SPEED * this.radarSweepDirection;
            if (this.radarSweepAngle >= RADAR_SWEEP_ANGLE / 2) {
                this.radarSweepAngle = RADAR_SWEEP_ANGLE / 2;
                this.radarSweepDirection = -1;
            } else if (this.radarSweepAngle <= -RADAR_SWEEP_ANGLE / 2) {
                this.radarSweepAngle = -RADAR_SWEEP_ANGLE / 2;
                this.radarSweepDirection = 1;
            }
        }

        const rotateAmount = Math.min(ROTATION_SPEED, this.rotationRemaining);
        this.angle = (this.angle + rotateAmount * this.rotationDirection + 360) % 360 | 0;
        this.rotationRemaining -= rotateAmount;

        if (this.rotationRemaining <= 0) {
            this.state = TankState.FIRING;
            this.fireDelay = 10;
        }
    }

    shootBullet() {
        const cos = fastCos(this.angle);
        const sin = fastSin(this.angle);
        const bulletX = this.x + cos * (this.size / 2 + 5);
        const bulletY = this.y + sin * (this.size / 2 + 5);

        // Use object pool
        let bullet = bulletPool.pop();
        if (bullet) {
            bullet.reset(bulletX, bulletY, this.angle, this.colorObj, this.id);
        } else {
            bullet = new Bullet(bulletX, bulletY, this.angle, this.colorObj, this.id);
        }

        if (gameMode === 'teams') {
            bullet.ownerTeam = this.team;
        }
        bullets.push(bullet);
    }

    fire() {
        if (--this.fireDelay <= 0) {
            this.shootBullet();
            this.state = TankState.MOVING;
        }
    }

    takeDamage(amount) {
        if (this.shieldUntilMs && nowMs < this.shieldUntilMs) {
            return;
        }
        this.health -= amount;
        if (this.health <= 0) {
            this.health = 0;
            this.die();
        }
    }

    die() {
        this.state = TankState.DEAD;
        // Use object pool for explosion particles
        let explosion = explosionPool.pop();
        if (explosion) {
            explosion.reset(this.x, this.y, this.colorObj, false);
        } else {
            explosion = new Explosion(this.x, this.y, this.colorObj, false);
        }
        explosions.push(explosion);

        // Expanding fire ring
        let fireRing = fireRingPool.pop();
        if (fireRing) {
            fireRing.reset(this.x, this.y, this.colorObj);
        } else {
            fireRing = new FireRing(this.x, this.y, this.colorObj);
        }
        fireRings.push(fireRing);
    }

    draw() {
        if (this.state === TankState.DEAD) return;

        const x = this.x | 0;
        const y = this.y | 0;

        // Draw predator radar
        if (this.isPredator) {
            // Calculate sweeping radar beam position
            const radarAngle = this.angle + this.radarSweepAngle;
            const radarRad = (radarAngle - 90) * DEG_TO_RAD;
            const radarEndX = x + Math.cos(radarRad) * RADAR_RANGE;
            const radarEndY = y + Math.sin(radarRad) * RADAR_RANGE;

            // Draw radar sweep area (faded trail)
            ctx.save();
            ctx.translate(x, y);
            ctx.rotate((this.angle - 90) * DEG_TO_RAD);

            // Radar sweep cone background
            ctx.beginPath();
            ctx.moveTo(0, 0);
            const halfSweep = (RADAR_SWEEP_ANGLE / 2) * DEG_TO_RAD;
            ctx.arc(0, 0, RADAR_RANGE, -halfSweep, halfSweep);
            ctx.closePath();
            ctx.fillStyle = `hsla(${this.rainbowHue}, 100%, 50%, 0.08)`;
            ctx.fill();

            // Radar sweep trail (fading arc behind the beam)
            const trailAngle = this.radarSweepAngle * DEG_TO_RAD;
            const trailStart = trailAngle - (this.radarSweepDirection * 0.4);
            ctx.beginPath();
            ctx.moveTo(0, 0);
            ctx.arc(0, 0, RADAR_RANGE, Math.min(trailStart, trailAngle), Math.max(trailStart, trailAngle));
            ctx.closePath();
            ctx.fillStyle = `hsla(${this.rainbowHue}, 100%, 60%, 0.15)`;
            ctx.fill();

            ctx.restore();

            // Main radar beam line
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(radarEndX | 0, radarEndY | 0);
            ctx.strokeStyle = `hsla(${this.rainbowHue}, 100%, 70%, 0.9)`;
            ctx.lineWidth = 3;
            ctx.stroke();

            // Radar beam glow
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(radarEndX | 0, radarEndY | 0);
            ctx.strokeStyle = `hsla(${this.rainbowHue}, 100%, 50%, 0.4)`;
            ctx.lineWidth = 8;
            ctx.stroke();

            // Radar ping at end of beam
            const pingSize = 6 + Math.sin(this.radarPulse * 3) * 2;
            ctx.beginPath();
            ctx.arc(radarEndX | 0, radarEndY | 0, pingSize, 0, Math.PI * 2);
            ctx.fillStyle = `hsla(${this.rainbowHue}, 100%, 80%, 0.9)`;
            ctx.fill();

            // Target lock indicator if we have a target
            if (this.targetTank && this.targetTank.state !== TankState.DEAD) {
                const tx = this.targetTank.x | 0;
                const ty = this.targetTank.y | 0;

                // Draw targeting brackets around locked target
                ctx.strokeStyle = `hsla(${this.rainbowHue}, 100%, 60%, 0.8)`;
                ctx.lineWidth = 2;
                const bracketSize = 20;
                const gap = 8;

                // Top-left bracket
                ctx.beginPath();
                ctx.moveTo(tx - bracketSize, ty - gap);
                ctx.lineTo(tx - bracketSize, ty - bracketSize);
                ctx.lineTo(tx - gap, ty - bracketSize);
                ctx.stroke();

                // Top-right bracket
                ctx.beginPath();
                ctx.moveTo(tx + gap, ty - bracketSize);
                ctx.lineTo(tx + bracketSize, ty - bracketSize);
                ctx.lineTo(tx + bracketSize, ty - gap);
                ctx.stroke();

                // Bottom-left bracket
                ctx.beginPath();
                ctx.moveTo(tx - bracketSize, ty + gap);
                ctx.lineTo(tx - bracketSize, ty + bracketSize);
                ctx.lineTo(tx - gap, ty + bracketSize);
                ctx.stroke();

                // Bottom-right bracket
                ctx.beginPath();
                ctx.moveTo(tx + gap, ty + bracketSize);
                ctx.lineTo(tx + bracketSize, ty + bracketSize);
                ctx.lineTo(tx + bracketSize, ty + gap);
                ctx.stroke();
            }

            // Rainbow pulsing glow around tank
            ctx.beginPath();
            ctx.arc(x, y, this.size / 2 + 8 + Math.sin(this.radarPulse) * 3, 0, Math.PI * 2);
            ctx.strokeStyle = `hsla(${this.rainbowHue}, 100%, 50%, 0.6)`;
            ctx.lineWidth = 4;
            ctx.stroke();

            // Secondary glow ring
            ctx.beginPath();
            ctx.arc(x, y, this.size / 2 + 14 + Math.sin(this.radarPulse + 1) * 3, 0, Math.PI * 2);
            ctx.strokeStyle = `hsla(${(this.rainbowHue + 60) % 360}, 100%, 50%, 0.3)`;
            ctx.lineWidth = 2;
            ctx.stroke();
        }

        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(this.angle * DEG_TO_RAD);

        // Draw pre-rendered sprite
        const offset = (this.sprite.width / 2) | 0;
        ctx.drawImage(this.sprite, -offset, -offset);

        ctx.restore();

        // Predator indicator above tank
        if (this.isPredator) {
            ctx.font = 'bold 12px Courier New';
            ctx.textAlign = 'center';
            ctx.fillStyle = `hsl(${this.rainbowHue}, 100%, 60%)`;
            ctx.fillText('☠', x, y - this.size / 2 - 12);
        }

        // Missile indicator and range
        if (this.hasMissiles) {
            // Draw missile seek range as faint grey circle
            ctx.beginPath();
            ctx.arc(x, y, MISSILE_SEEK_RANGE, 0, Math.PI * 2);
            ctx.strokeStyle = 'rgba(150, 150, 150, 0.2)';
            ctx.lineWidth = 1;
            ctx.stroke();

            // Icon above tank
            ctx.font = '12px serif';
            ctx.textAlign = 'center';
            ctx.fillText('🚀', x + (this.isPredator ? 10 : 0), y - this.size / 2 - 12);
        }

        // Shield indicator
        if (this.shieldUntilMs && nowMs < this.shieldUntilMs) {
            const hueCycle = 215 + 15 * Math.sin(frameCount * 0.05);
            const pulse = 0.5 + 0.5 * Math.sin(frameCount * 0.12);
            const shieldRadius = this.size * 2;
            ctx.beginPath();
            ctx.arc(x, y, shieldRadius, 0, Math.PI * 2);
            ctx.strokeStyle = `hsla(${hueCycle}, 100%, ${45 + 20 * pulse}%, 0.95)`;
            ctx.lineWidth = 5;
            ctx.stroke();

            ctx.beginPath();
            ctx.arc(x, y, shieldRadius + 10, 0, Math.PI * 2);
            ctx.strokeStyle = `hsla(${hueCycle}, 100%, ${50 + 15 * pulse}%, ${0.18 + 0.22 * pulse})`;
            ctx.lineWidth = 10;
            ctx.stroke();
        }

        // Health bar (only draw if damaged)
        if (this.health < maxHealth) {
            const barWidth = this.size;
            const barHeight = 4;
            const barX = (x - barWidth / 2) | 0;
            const barY = (y + this.size / 2 + 5) | 0;

            ctx.fillStyle = '#333';
            ctx.fillRect(barX, barY, barWidth, barHeight);

            const healthPercent = this.health / maxHealth;
            ctx.fillStyle = healthPercent > 0.5 ? '#0f0' : healthPercent > 0.25 ? '#ff0' : '#f00';
            ctx.fillRect(barX, barY, (barWidth * healthPercent) | 0, barHeight);
        }
    }
}

class Bullet {
    constructor(x, y, angle, colorObj, ownerId) {
        this.reset(x, y, angle, colorObj, ownerId);
    }

    reset(x, y, angle, colorObj, ownerId) {
        this.x = x;
        this.y = y;
        this.angle = angle;
        this.colorObj = colorObj;
        this.color = colorObj.hex;
        this.ownerId = ownerId;
        this.ownerTeam = null;
        this.active = true;
        this.size = BULLET_SIZE;
        this.cos = fastCos(angle);
        this.sin = fastSin(angle);
    }

    update() {
        if (!this.active) return;

        this.x += this.cos * BULLET_SPEED;
        this.y += this.sin * BULLET_SPEED;

        // Wall collision
        if (this.x < WALL_THICKNESS || this.x > canvasWidth - WALL_THICKNESS ||
            this.y < WALL_THICKNESS || this.y > canvasHeight - WALL_THICKNESS) {
            this.active = false;
            return;
        }

        // Tank collision using spatial grid
        const nearby = getNearbyEntities(this.x, this.y, TANK_SIZE * 3);
        for (let i = 0; i < nearby.length; i++) {
            const tank = nearby[i];
            if (tank.id === this.ownerId || tank.state === TankState.DEAD) continue;
            if (gameMode === 'teams' && this.ownerTeam && tank.team === this.ownerTeam) continue;

            const dx = this.x - tank.x;
            const dy = this.y - tank.y;
            const distSq = dx * dx + dy * dy;
            const shieldActive = tank.shieldUntilMs && nowMs < tank.shieldUntilMs;
            const targetRadius = shieldActive ? tank.size * 2 : tank.size / 2;
            const hitDist = targetRadius + this.size / 2;

            if (distSq < hitDist * hitDist) {
                if (shieldActive) {
                    spawnShieldPing(tank);
                } else {
                    tank.takeDamage(DAMAGE_PER_HIT);
                }
                this.active = false;

                // Small hit explosion from pool
                let explosion = explosionPool.pop();
                if (explosion) {
                    explosion.reset(this.x, this.y, this.colorObj, true);
                } else {
                    explosion = new Explosion(this.x, this.y, this.colorObj, true);
                }
                explosions.push(explosion);
                return;
            }
        }
    }

    draw() {
        if (!this.active) return;

        const x = this.x | 0;
        const y = this.y | 0;

        // Simple bullet - no glow for performance
        ctx.beginPath();
        ctx.arc(x, y, this.size, 0, Math.PI * 2);
        ctx.fillStyle = this.color;
        ctx.fill();
    }
}

class Missile {
    constructor(x, y, angle, colorObj, ownerId) {
        this.reset(x, y, angle, colorObj, ownerId);
    }

    reset(x, y, angle, colorObj, ownerId) {
        this.x = x;
        this.y = y;
        this.angle = angle;
        this.colorObj = colorObj;
        this.color = colorObj.hex;
        this.ownerId = ownerId;
        this.ownerTeam = null;
        this.targetMode = 'random';
        this.active = true;
        this.target = null;
        this.lifetime = 300; // Missiles explode after 5 seconds (60fps)
        this.trailParticles = [];
    }

    isValidTarget(tank) {
        if (!tank) return false;
        if (tank.id === this.ownerId) return false;
        if (tank.state === TankState.DEAD) return false;

        if (this.targetMode === 'red') return tank.team === 'red';
        if (this.targetMode === 'blue') return tank.team === 'blue';
        return true;
    }

    findTarget() {
        const nearby = getNearbyEntities(this.x, this.y, MISSILE_SEEK_RANGE);
        let closestTarget = null;
        let closestDist = MISSILE_SEEK_RANGE * MISSILE_SEEK_RANGE;

        for (let i = 0; i < nearby.length; i++) {
            const tank = nearby[i];
            if (!this.isValidTarget(tank)) continue;

            const dx = tank.x - this.x;
            const dy = tank.y - this.y;
            const distSq = dx * dx + dy * dy;

            if (distSq < closestDist) {
                closestDist = distSq;
                closestTarget = tank;
            }
        }

        return closestTarget;
    }

    update() {
        if (!this.active) return;

        this.lifetime--;
        if (this.lifetime <= 0) {
            this.active = false;
            // Explode when lifetime runs out
            let explosion = explosionPool.pop();
            if (explosion) {
                explosion.reset(this.x, this.y, this.colorObj, false);
            } else {
                explosion = new Explosion(this.x, this.y, this.colorObj, false);
            }
            explosions.push(explosion);
            return;
        }

        // Find or update target
        if (!this.isValidTarget(this.target)) {
            this.target = this.findTarget();
        }

        // Home in on target
        if (this.target) {
            const dx = this.target.x - this.x;
            const dy = this.target.y - this.y;
            let targetAngle = (Math.atan2(dy, dx) * 180 / Math.PI + 90 + 360) % 360;

            // Calculate shortest rotation
            let angleDiff = targetAngle - this.angle;
            if (angleDiff > 180) angleDiff -= 360;
            if (angleDiff < -180) angleDiff += 360;

            // Turn toward target
            if (Math.abs(angleDiff) > MISSILE_TURN_SPEED) {
                this.angle += angleDiff > 0 ? MISSILE_TURN_SPEED : -MISSILE_TURN_SPEED;
            } else {
                this.angle = targetAngle;
            }
            this.angle = (this.angle + 360) % 360;
        }

        // Move forward
        const rad = (this.angle - 90) * DEG_TO_RAD;
        this.x += Math.cos(rad) * MISSILE_SPEED;
        this.y += Math.sin(rad) * MISSILE_SPEED;

        // Add trail particle
        if (frameCount % 2 === 0) {
            this.trailParticles.push({
                x: this.x,
                y: this.y,
                life: 1
            });
            if (this.trailParticles.length > 15) {
                this.trailParticles.shift();
            }
        }

        // Update trail
        for (let i = this.trailParticles.length - 1; i >= 0; i--) {
            this.trailParticles[i].life -= 0.1;
            if (this.trailParticles[i].life <= 0) {
                this.trailParticles.splice(i, 1);
            }
        }

        // Wall collision
        if (this.x < WALL_THICKNESS || this.x > canvasWidth - WALL_THICKNESS ||
            this.y < WALL_THICKNESS || this.y > canvasHeight - WALL_THICKNESS) {
            this.active = false;
            // Small explosion on wall hit
            let explosion = explosionPool.pop();
            if (explosion) {
                explosion.reset(this.x, this.y, this.colorObj, true);
            } else {
                explosion = new Explosion(this.x, this.y, this.colorObj, true);
            }
            explosions.push(explosion);
            return;
        }

        // Tank collision
        const nearby = getNearbyEntities(this.x, this.y, TANK_SIZE * 3);
        for (let i = 0; i < nearby.length; i++) {
            const tank = nearby[i];
            if (tank.id === this.ownerId || tank.state === TankState.DEAD) continue;
            if (!this.isValidTarget(tank)) continue;

            const dx = this.x - tank.x;
            const dy = this.y - tank.y;
            const distSq = dx * dx + dy * dy;
            const shieldActive = tank.shieldUntilMs && nowMs < tank.shieldUntilMs;
            const targetRadius = shieldActive ? tank.size * 2 : tank.size / 2;
            const hitDist = targetRadius + 8;

            if (distSq < hitDist * hitDist) {
                if (shieldActive) {
                    spawnShieldPing(tank);
                } else {
                    tank.takeDamage(DAMAGE_PER_HIT * 2); // Missiles do double damage
                }
                this.active = false;

                // Explosion on hit
                let explosion = explosionPool.pop();
                if (explosion) {
                    explosion.reset(this.x, this.y, this.colorObj, false);
                } else {
                    explosion = new Explosion(this.x, this.y, this.colorObj, false);
                }
                explosions.push(explosion);
                return;
            }
        }
    }

    draw() {
        if (!this.active) return;

        // Draw trail
        for (let i = 0; i < this.trailParticles.length; i++) {
            const p = this.trailParticles[i];
            ctx.beginPath();
            ctx.arc(p.x | 0, p.y | 0, 3 * p.life, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(255, ${150 + (105 * p.life) | 0}, 0, ${p.life * 0.7})`;
            ctx.fill();
        }

        const x = this.x | 0;
        const y = this.y | 0;

        ctx.save();
        ctx.translate(x, y);
        // Rocket emoji points upper-right (~45°), so subtract 45 to compensate
        ctx.rotate((this.angle - 45) * DEG_TO_RAD);

        // Draw missile emoji rotated
        ctx.font = '20px serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('🚀', 0, 0);

        ctx.restore();

        // Draw seeking indicator if has target
        if (this.target && this.target.state !== TankState.DEAD) {
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(this.target.x | 0, this.target.y | 0);
            ctx.strokeStyle = `rgba(255, 100, 0, 0.2)`;
            ctx.lineWidth = 1;
            ctx.setLineDash([5, 5]);
            ctx.stroke();
            ctx.setLineDash([]);
        }
    }
}

class Explosion {
    constructor(x, y, colorObj, small) {
        this.particles = [];
        this.reset(x, y, colorObj, small);
    }

    reset(x, y, colorObj, small) {
        this.x = x;
        this.y = y;
        this.colorObj = colorObj;
        this.active = true;

        const particleCount = small ? 8 : 20;
        const maxSpeed = small ? 3 : 6;
        const maxSize = small ? 4 : 8;

        // Reuse or create particles
        while (this.particles.length < particleCount) {
            this.particles.push({});
        }

        for (let i = 0; i < particleCount; i++) {
            const angle = Math.random() * Math.PI * 2;
            const speed = Math.random() * maxSpeed + 1;
            const p = this.particles[i];
            p.x = x;
            p.y = y;
            p.vx = Math.cos(angle) * speed;
            p.vy = Math.sin(angle) * speed;
            p.size = Math.random() * maxSize + 2;
            p.life = 1;
            p.decay = 0.03 + Math.random() * 0.04;
            p.colorIdx = Math.random() < 0.5 ? 0 : (Math.random() < 0.5 ? 1 : 2);
            p.active = true;
        }

        // Mark excess particles as inactive
        for (let i = particleCount; i < this.particles.length; i++) {
            this.particles[i].active = false;
        }
    }

    update() {
        let allDead = true;

        for (let i = 0; i < this.particles.length; i++) {
            const p = this.particles[i];
            if (!p.active || p.life <= 0) continue;

            allDead = false;
            p.x += p.vx;
            p.y += p.vy;
            p.vx *= 0.96;
            p.vy *= 0.96;
            p.life -= p.decay;
            p.size *= 0.95;
        }

        if (allDead) {
            this.active = false;
        }
    }

    draw() {
        const colors = [this.colorObj.hex, '#f60', '#ff0'];

        for (let i = 0; i < this.particles.length; i++) {
            const p = this.particles[i];
            if (!p.active || p.life <= 0 || p.size < 0.5) continue;

            ctx.globalAlpha = p.life;
            ctx.beginPath();
            ctx.arc(p.x | 0, p.y | 0, p.size | 0, 0, Math.PI * 2);
            ctx.fillStyle = colors[p.colorIdx];
            ctx.fill();
        }
        ctx.globalAlpha = 1;
    }
}

class FireRing {
    constructor(x, y, colorObj) {
        this.reset(x, y, colorObj);
    }

    reset(x, y, colorObj) {
        this.x = x;
        this.y = y;
        this.colorObj = colorObj;
        this.radius = 10;
        this.expandSpeed = 8;
        this.thickness = 20;
        this.active = true;
        this.opacity = 1;
        // Calculate max radius needed to go offscreen
        const maxDistX = Math.max(x, canvasWidth - x);
        const maxDistY = Math.max(y, canvasHeight - y);
        this.maxRadius = Math.sqrt(maxDistX * maxDistX + maxDistY * maxDistY) + 50;
    }

    update() {
        if (!this.active) return;

        this.radius += this.expandSpeed;
        this.thickness = Math.max(5, 20 - this.radius * 0.02);

        // Fade out as it expands
        this.opacity = Math.max(0, 1 - (this.radius / this.maxRadius));

        if (this.radius > this.maxRadius) {
            this.active = false;
        }
    }

    draw() {
        if (!this.active || this.opacity <= 0) return;

        const x = this.x | 0;
        const y = this.y | 0;

        ctx.save();
        ctx.globalAlpha = this.opacity;

        // Outer glow
        ctx.beginPath();
        ctx.arc(x, y, this.radius + this.thickness, 0, Math.PI * 2);
        ctx.arc(x, y, Math.max(0, this.radius - this.thickness), 0, Math.PI * 2, true);
        ctx.fillStyle = `rgba(255, 100, 0, ${this.opacity * 0.3})`;
        ctx.fill();

        // Main fire ring
        ctx.beginPath();
        ctx.arc(x, y, this.radius, 0, Math.PI * 2);
        ctx.lineWidth = this.thickness;

        // Gradient from tank color to orange to yellow
        const gradient = ctx.createRadialGradient(x, y, this.radius - this.thickness/2, x, y, this.radius + this.thickness/2);
        gradient.addColorStop(0, '#ff0');
        gradient.addColorStop(0.3, '#f80');
        gradient.addColorStop(0.6, this.colorObj.hex);
        gradient.addColorStop(1, '#f40');

        ctx.strokeStyle = gradient;
        ctx.stroke();

        // Inner bright core
        ctx.beginPath();
        ctx.arc(x, y, this.radius, 0, Math.PI * 2);
        ctx.lineWidth = this.thickness * 0.3;
        ctx.strokeStyle = `rgba(255, 255, 200, ${this.opacity * 0.8})`;
        ctx.stroke();

        ctx.restore();
    }
}

// Pre-render arena to offscreen canvas
function prerenderArena() {
    arenaCanvas = document.createElement('canvas');
    arenaCanvas.width = canvasWidth;
    arenaCanvas.height = canvasHeight;
    arenaCtx = arenaCanvas.getContext('2d');

    // Background
    arenaCtx.fillStyle = '#2d2d44';
    arenaCtx.fillRect(0, 0, canvasWidth, canvasHeight);

    // Floor pattern (grid)
    arenaCtx.strokeStyle = '#3d3d54';
    arenaCtx.lineWidth = 1;
    const gridSize = 40;

    arenaCtx.beginPath();
    for (let x = WALL_THICKNESS; x < canvasWidth - WALL_THICKNESS; x += gridSize) {
        arenaCtx.moveTo(x, WALL_THICKNESS);
        arenaCtx.lineTo(x, canvasHeight - WALL_THICKNESS);
    }
    for (let y = WALL_THICKNESS; y < canvasHeight - WALL_THICKNESS; y += gridSize) {
        arenaCtx.moveTo(WALL_THICKNESS, y);
        arenaCtx.lineTo(canvasWidth - WALL_THICKNESS, y);
    }
    arenaCtx.stroke();

    // Walls
    arenaCtx.fillStyle = '#e94560';
    arenaCtx.fillRect(0, 0, canvasWidth, WALL_THICKNESS);
    arenaCtx.fillRect(0, canvasHeight - WALL_THICKNESS, canvasWidth, WALL_THICKNESS);
    arenaCtx.fillRect(0, 0, WALL_THICKNESS, canvasHeight);
    arenaCtx.fillRect(canvasWidth - WALL_THICKNESS, 0, WALL_THICKNESS, canvasHeight);

    // Wall highlights
    arenaCtx.fillStyle = '#ff6b6b';
    arenaCtx.fillRect(0, 0, canvasWidth, 4);
    arenaCtx.fillRect(0, 0, 4, canvasHeight);
}

function resizeCanvas() {
    canvasWrapper = document.getElementById('canvasWrapper');
    canvas = document.getElementById('gameCanvas');
    ctx = canvas.getContext('2d');

    canvasWidth = canvasWrapper.clientWidth;
    canvasHeight = canvasWrapper.clientHeight;

    canvas.width = canvasWidth;
    canvas.height = canvasHeight;

    // Update spatial grid dimensions
    gridCols = Math.ceil(canvasWidth / GRID_CELL_SIZE);
    gridRows = Math.ceil(canvasHeight / GRID_CELL_SIZE);

    // Re-render arena
    prerenderArena();
}

function initGame() {
    canvas = document.getElementById('gameCanvas');
    canvasWrapper = document.getElementById('canvasWrapper');
    ctx = canvas.getContext('2d');

    // Get tank count from input
    const tankCountInput = document.getElementById('tankCount');
    numTanks = parseInt(tankCountInput.value) || 6;
    numTanks = Math.max(2, numTanks);
    tankCountInput.value = numTanks;

    const predatorPercentInput = document.getElementById('predatorPercent');
    if (predatorPercentInput) {
        const raw = predatorPercentInput.value.trim();
        if (raw === '') {
            predatorChance = DEFAULT_PREDATOR_CHANCE;
        } else {
            const pct = parseFloat(raw);
            predatorChance = Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) / 100 : DEFAULT_PREDATOR_CHANCE;
        }
    }

    const missilePercentInput = document.getElementById('missilePercent');
    if (missilePercentInput) {
        const raw = missilePercentInput.value.trim();
        if (raw === '') {
            missileChance = DEFAULT_MISSILE_CHANCE;
        } else {
            const pct = parseFloat(raw);
            missileChance = Number.isFinite(pct) ? Math.min(100, Math.max(0, pct)) / 100 : DEFAULT_MISSILE_CHANCE;
        }
    }

    const healthPointsInput = document.getElementById('healthPoints');
    if (healthPointsInput) {
        const raw = healthPointsInput.value.trim();
        if (raw === '') {
            maxHealth = DEFAULT_MAX_HEALTH;
        } else {
            const hp = parseInt(raw);
            maxHealth = Number.isFinite(hp) ? Math.max(1, hp) : DEFAULT_MAX_HEALTH;
        }
    }

    const gameModeSelect = document.getElementById('gameMode');
    if (gameModeSelect) {
        gameMode = gameModeSelect.value === 'teams' ? 'teams' : 'random';
    } else {
        gameMode = 'random';
    }

    // Resize canvas
    resizeCanvas();

    // Clear caches for fresh game
    tankCanvasCache.clear();

    // Reset pools
    bulletPool.length = 0;
    explosionPool.length = 0;

    tanks = [];
    bullets = [];
    missiles = [];
    explosions = [];
    fireRings = [];
    blessingRings = [];
    powerUps = [];
    shieldPings = [];
    winner = null;
    gameRunning = true;
    frameCount = 0;
    nextTankId = 0;
    nextPowerUpSpawnMs = 0;

    // Spawn tanks
    const margin = WALL_THICKNESS + TANK_SIZE;
    const usedPositions = [];

    for (let i = 0; i < numTanks; i++) {
        let x, y;
        let validPosition = false;
        let attempts = 0;
        const maxAttempts = Math.min(200, numTanks);

        while (!validPosition && attempts < maxAttempts) {
            x = margin + Math.random() * (canvasWidth - 2 * margin);
            y = margin + Math.random() * (canvasHeight - 2 * margin);

            validPosition = true;
            for (let j = 0; j < usedPositions.length; j++) {
                const pos = usedPositions[j];
                const dx = x - pos.x;
                const dy = y - pos.y;
                if (dx * dx + dy * dy < TANK_SIZE * TANK_SIZE * 2.25) {
                    validPosition = false;
                    break;
                }
            }
            attempts++;
        }

        if (!validPosition) {
            x = margin + Math.random() * (canvasWidth - 2 * margin);
            y = margin + Math.random() * (canvasHeight - 2 * margin);
        }

        usedPositions.push({ x, y });
        const id = nextTankId++;
        const tank = new Tank(x, y, generateTankColor(id), id);
        if (gameMode === 'teams') {
            tank.team = (i % 2 === 0) ? 'red' : 'blue';
            tank.colorObj = tank.team === 'red'
                ? { hex: '#ff3b3b', r: 255, g: 59, b: 59 }
                : { hex: '#2f80ff', r: 47, g: 128, b: 255 };
            tank.color = tank.colorObj.hex;
            tank.sprite = getTankSprite(tank.colorObj);
        }
        tanks.push(tank);
    }

    updateUI();
    document.getElementById('winner').textContent = '';
}

function updateUI() {
    // Only update UI every 10 frames for performance
    if (frameCount % 10 !== 0) return;

    const ui = document.getElementById('ui');

    let aliveCount = 0;
    let deadCount = 0;
    for (let i = 0; i < tanks.length; i++) {
        if (tanks[i].state === TankState.DEAD) deadCount++;
        else aliveCount++;
    }

    // For massive battles, just show summary
    if (tanks.length > 100) {
        ui.innerHTML = `<div class="tank-status" style="background:#444">ALIVE: ${aliveCount} | DESTROYED: ${deadCount} | TOTAL: ${tanks.length}</div>`;
        return;
    }

    // Build HTML string instead of DOM manipulation
    let html = '';
    const compact = tanks.length > 20;

    for (let i = 0; i < tanks.length; i++) {
        const tank = tanks[i];
        const isDead = tank.state === TankState.DEAD;
        const opacity = isDead ? 0.3 : 1;
        const textDecor = isDead ? 'text-decoration:line-through;' : '';
        const cls = compact ? 'tank-status compact' : 'tank-status';
        const predatorIcon = tank.isPredator ? '☠' : '';
        const missileIcon = tank.hasMissiles ? '🚀' : '';
        const icons = (predatorIcon + missileIcon) ? (predatorIcon + missileIcon + ' ') : '';
        const text = compact
            ? (isDead ? `${icons}#${tank.id + 1}: X` : `${icons}#${tank.id + 1}: ${tank.health}`)
            : (isDead ? `${icons}Tank ${tank.id + 1}: DESTROYED` : `${icons}Tank ${tank.id + 1}: ${tank.health} HP`);

        html += `<div class="${cls}" style="background:${tank.color};opacity:${opacity};${textDecor}">${text}</div>`;
    }

    ui.innerHTML = html;
}

function drawArena() {
    // Draw pre-rendered arena
    ctx.drawImage(arenaCanvas, 0, 0);
}

function drawTeamCountsOverlay() {
    if (gameMode !== 'teams') return;

    let redAlive = 0;
    let blueAlive = 0;
    for (let i = 0; i < tanks.length; i++) {
        if (tanks[i].state === TankState.DEAD) continue;
        if (tanks[i].team === 'red') redAlive++;
        else if (tanks[i].team === 'blue') blueAlive++;
    }

    ctx.save();
    ctx.globalAlpha = 0.22;
    const pad = Math.max(24, (canvasWidth * 0.03) | 0);
    const fontPx = Math.max(48, (canvasHeight * 0.5) | 0);
    ctx.font = `bold ${fontPx}px Pixelify Sans, Lucida Console, Monaco, monospace`;
    ctx.textBaseline = 'alphabetic';

    ctx.textAlign = 'left';
    ctx.fillStyle = '#ff3b3b';
    ctx.fillText(String(redAlive), pad, canvasHeight - pad);

    ctx.textAlign = 'right';
    ctx.fillStyle = '#2f80ff';
    ctx.fillText(String(blueAlive), canvasWidth - pad, canvasHeight - pad);

    ctx.restore();
}

function checkWinner() {
    if (gameMode === 'teams') {
        let redAlive = 0;
        let blueAlive = 0;

        for (let i = 0; i < tanks.length; i++) {
            if (tanks[i].state === TankState.DEAD) continue;
            if (tanks[i].team === 'red') redAlive++;
            else if (tanks[i].team === 'blue') blueAlive++;
        }

        if (redAlive > 0 && blueAlive > 0) return;

        gameRunning = false;
        if (redAlive > 0) {
            document.getElementById('winner').textContent = '🏆 RED TEAM WINS! 🏆';
            document.getElementById('winner').style.color = '#ff3b3b';
        } else if (blueAlive > 0) {
            document.getElementById('winner').textContent = '🏆 BLUE TEAM WINS! 🏆';
            document.getElementById('winner').style.color = '#2f80ff';
        } else {
            document.getElementById('winner').textContent = '💥 DRAW - ALL TANKS DESTROYED! 💥';
        }
        return;
    }

    let aliveCount = 0;
    let lastAlive = null;

    for (let i = 0; i < tanks.length; i++) {
        if (tanks[i].state !== TankState.DEAD) {
            aliveCount++;
            lastAlive = tanks[i];
            if (aliveCount > 1) return; // Early exit
        }
    }

    if (aliveCount === 1) {
        winner = lastAlive;
        gameRunning = false;
        document.getElementById('winner').textContent = `🏆 TANK ${winner.id + 1} WINS! 🏆`;
        document.getElementById('winner').style.color = winner.color;
    } else if (aliveCount === 0) {
        gameRunning = false;
        document.getElementById('winner').textContent = '💥 DRAW - ALL TANKS DESTROYED! 💥';
    }
}

function gameLoop(timestamp) {
    frameCount++;

    if (typeof timestamp === 'number') {
        nowMs = timestamp;
        if (!nextPowerUpSpawnMs) nextPowerUpSpawnMs = nowMs + POWERUP_SPAWN_INTERVAL_MS;
    }

    if (!paused && gameRunning) {
        // Rebuild spatial grid
        clearSpatialGrid();
        for (let i = 0; i < tanks.length; i++) {
            if (tanks[i].state !== TankState.DEAD) {
                addToSpatialGrid(tanks[i]);
            }
        }

        // Update tanks
        for (let i = 0; i < tanks.length; i++) {
            tanks[i].update();
        }

        // Spawn and process power ups
        if (nowMs >= nextPowerUpSpawnMs) {
            spawnPowerUp();
            nextPowerUpSpawnMs = nowMs + POWERUP_SPAWN_INTERVAL_MS;
        }
        updatePowerUpPickups();

        // Update bullets
        for (let i = bullets.length - 1; i >= 0; i--) {
            bullets[i].update();
            if (!bullets[i].active) {
                bulletPool.push(bullets[i]);
                bullets.splice(i, 1);
            }
        }

        // Update missiles
        for (let i = missiles.length - 1; i >= 0; i--) {
            missiles[i].update();
            if (!missiles[i].active) {
                missilePool.push(missiles[i]);
                missiles.splice(i, 1);
            }
        }

        // Update explosions
        for (let i = explosions.length - 1; i >= 0; i--) {
            explosions[i].update();
            if (!explosions[i].active) {
                explosionPool.push(explosions[i]);
                explosions.splice(i, 1);
            }
        }

        // Update fire rings
        for (let i = fireRings.length - 1; i >= 0; i--) {
            fireRings[i].update();
            if (!fireRings[i].active) {
                fireRingPool.push(fireRings[i]);
                fireRings.splice(i, 1);
            }
        }

        // Update blessing rings
        for (let i = blessingRings.length - 1; i >= 0; i--) {
            blessingRings[i].update();
            if (!blessingRings[i].active) {
                blessingRingPool.push(blessingRings[i]);
                blessingRings.splice(i, 1);
            }
        }

        // Update shield pings
        for (let i = shieldPings.length - 1; i >= 0; i--) {
            shieldPings[i].update();
            if (!shieldPings[i].active) {
                shieldPingPool.push(shieldPings[i]);
                shieldPings.splice(i, 1);
            }
        }

        checkWinner();
        updateUI();
    }

    // Draw
    drawArena();

    drawTeamCountsOverlay();

    // Draw power ups
    for (let i = 0; i < powerUps.length; i++) {
        powerUps[i].draw();
    }

    // Draw shield pings
    for (let i = 0; i < shieldPings.length; i++) {
        shieldPings[i].draw();
    }

    // Draw bullets
    for (let i = 0; i < bullets.length; i++) {
        bullets[i].draw();
    }

    // Draw missiles
    for (let i = 0; i < missiles.length; i++) {
        missiles[i].draw();
    }

    // Draw tanks
    for (let i = 0; i < tanks.length; i++) {
        tanks[i].draw();
    }

    // Draw explosions
    for (let i = 0; i < explosions.length; i++) {
        explosions[i].draw();
    }

    // Draw fire rings
    for (let i = 0; i < fireRings.length; i++) {
        fireRings[i].draw();
    }

    // Draw blessing rings
    for (let i = 0; i < blessingRings.length; i++) {
        blessingRings[i].draw();
    }

    // Pause overlay
    if (paused) {
        ctx.fillStyle = 'rgba(0,0,0,0.5)';
        ctx.fillRect(0, 0, canvasWidth, canvasHeight);
        ctx.fillStyle = '#fff';
        ctx.font = '48px Courier New';
        ctx.textAlign = 'center';
        ctx.fillText('PAUSED', canvasWidth / 2, canvasHeight / 2);
    }

    requestAnimationFrame(gameLoop);
}

function restartGame() {
    syncUrlFromUI();
    initGame();
}

function togglePause() {
    paused = !paused;
}

function parsePercentParam(value, defaultPct) {
    if (value == null) return defaultPct;
    const raw = String(value).trim();
    if (raw === '') return defaultPct;
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) return defaultPct;
    return Math.min(100, Math.max(0, n));
}

function applySettingsFromUrlToUI() {
    const params = new URLSearchParams(window.location.search);
    if ([...params.keys()].length === 0) return;

    const tankCountInput = document.getElementById('tankCount');
    const gameModeSelect = document.getElementById('gameMode');
    const predatorPercentInput = document.getElementById('predatorPercent');
    const missilePercentInput = document.getElementById('missilePercent');
    const healthPointsInput = document.getElementById('healthPoints');

    if (tankCountInput && params.has('tanks')) {
        const v = parseInt(params.get('tanks'), 10);
        if (Number.isFinite(v)) tankCountInput.value = String(v);
    }

    if (gameModeSelect && params.has('mode')) {
        const mode = String(params.get('mode')).toLowerCase();
        gameModeSelect.value = mode === 'teams' ? 'teams' : 'random';
    }

    if (predatorPercentInput && (params.has('pred') || params.has('predators'))) {
        const v = params.get('pred') ?? params.get('predators');
        predatorPercentInput.value = String(parsePercentParam(v, 15));
    }

    if (missilePercentInput && (params.has('rockets') || params.has('missiles'))) {
        const v = params.get('rockets') ?? params.get('missiles');
        missilePercentInput.value = String(parsePercentParam(v, 15));
    }

    if (healthPointsInput && params.has('health')) {
        const v = parseInt(params.get('health'), 10);
        if (Number.isFinite(v)) healthPointsInput.value = String(v);
    }
}

function syncUrlFromUI() {
    const tankCountInput = document.getElementById('tankCount');
    const gameModeSelect = document.getElementById('gameMode');
    const predatorPercentInput = document.getElementById('predatorPercent');
    const missilePercentInput = document.getElementById('missilePercent');
    const healthPointsInput = document.getElementById('healthPoints');

    const params = new URLSearchParams(window.location.search);

    if (tankCountInput) params.set('tanks', String(parseInt(tankCountInput.value, 10) || 6));
    if (gameModeSelect) params.set('mode', gameModeSelect.value === 'teams' ? 'teams' : 'random');

    if (predatorPercentInput) {
        const raw = predatorPercentInput.value.trim();
        params.set('pred', raw === '' ? '15' : raw);
    }

    if (missilePercentInput) {
        const raw = missilePercentInput.value.trim();
        params.set('rockets', raw === '' ? '15' : raw);
    }

    if (healthPointsInput) {
        const raw = healthPointsInput.value.trim();
        params.set('health', raw === '' ? '100' : raw);
    }

    const newUrl = `${window.location.pathname}?${params.toString()}`;
    window.history.replaceState(null, '', newUrl);
}

// Handle window resize
window.addEventListener('resize', () => {
    resizeCanvas();
});

// Enter key to restart
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('tankCount').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') restartGame();
    });

    const predatorPercentInput = document.getElementById('predatorPercent');
    if (predatorPercentInput) {
        predatorPercentInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') restartGame();
        });
    }

    const missilePercentInput = document.getElementById('missilePercent');
    if (missilePercentInput) {
        missilePercentInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') restartGame();
        });
    }

    const healthPointsInput = document.getElementById('healthPoints');
    if (healthPointsInput) {
        healthPointsInput.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') restartGame();
        });
    }
});

// Start
applySettingsFromUrlToUI();
initGame();
gameLoop();
