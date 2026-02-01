// Game Constants
let canvasWidth = 800;
let canvasHeight = 600;
const WALL_THICKNESS = 20;
const TANK_SIZE = 30;
const TANK_SPEED = 3; // 1.5x faster
const BULLET_SPEED = 8;
const BULLET_SIZE = 6;
const MAX_HEALTH = 100;
const DAMAGE_PER_HIT = 10;
const ROTATION_SPEED = 4.5; // 1.5x faster
const GRID_CELL_SIZE = 60; // For spatial partitioning
const FIRE_INTERVAL = 60; // Frames between shots while moving (~1 second at 60fps)
const PREDATOR_CHANCE = 0.15; // 15% chance for a tank to be a predator
const RADAR_RANGE = 200; // Predator radar range in pixels
const PREDATOR_TURN_SPEED = 6; // How fast predators turn toward targets
const RADAR_SWEEP_SPEED = 3; // Degrees per frame for radar sweep
const RADAR_SWEEP_ANGLE = 60; // Total sweep angle (±30 degrees from center)
const MISSILE_CHANCE = 0.15; // 15% chance for missile ability
const MISSILE_SPEED = 4;
const MISSILE_TURN_SPEED = 5; // How fast missiles can turn
const MISSILE_SEEK_RANGE = 400; // Homing range
const MISSILE_FIRE_INTERVAL = 90; // Frames between missile shots

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
const missilePool = [];

// Fire rings from tank deaths
let fireRings = [];
let missiles = [];

// Pre-computed values
const DEG_TO_RAD = Math.PI / 180;
const sinTable = new Float32Array(360);
const cosTable = new Float32Array(360);

// Initialize lookup tables
for (let i = 0; i < 360; i++) {
    sinTable[i] = Math.sin((i - 90) * DEG_TO_RAD);
    cosTable[i] = Math.cos((i - 90) * DEG_TO_RAD);
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
        this.angle = (Math.random() * 360) | 0;
        this.health = MAX_HEALTH;
        this.state = TankState.MOVING;
        this.rotationRemaining = 0;
        this.rotationDirection = 1;
        this.fireDelay = 0;
        this.size = TANK_SIZE;
        this.sprite = getTankSprite(colorObj);
        this.movingFireTimer = (Math.random() * FIRE_INTERVAL) | 0; // Stagger initial fire times

        // Predator properties
        this.isPredator = Math.random() < PREDATOR_CHANCE;
        this.rainbowHue = Math.random() * 360;
        this.targetTank = null;
        this.radarPulse = 0;
        this.radarSweepAngle = 0; // Current sweep offset from tank angle
        this.radarSweepDirection = 1; // 1 = sweeping right, -1 = sweeping left

        // Missile properties
        this.hasMissiles = Math.random() < MISSILE_CHANCE;
        this.missileTimer = (Math.random() * MISSILE_FIRE_INTERVAL) | 0;
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

            // Scan for targets with radar beam
            const target = this.findTargetWithRadar();
            if (target) {
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
        const nextX = this.x + cos * TANK_SPEED;
        const nextY = this.y + sin * TANK_SPEED;

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
        const halfSize = this.size / 2;
        return (
            x - halfSize < WALL_THICKNESS ||
            x + halfSize > canvasWidth - WALL_THICKNESS ||
            y - halfSize < WALL_THICKNESS ||
            y + halfSize > canvasHeight - WALL_THICKNESS
        );
    }

    checkTankCollision(x, y) {
        const nearby = getNearbyEntities(x, y, this.size * 2);
        for (let i = 0; i < nearby.length; i++) {
            const tank = nearby[i];
            if (tank.id === this.id || tank.state === TankState.DEAD) continue;

            const dx = x - tank.x;
            const dy = y - tank.y;
            const distSq = dx * dx + dy * dy;
            const minDist = this.size;

            if (distSq < minDist * minDist) {
                return true;
            }
        }
        return false;
    }

    startRotation() {
        this.state = TankState.ROTATING;
        this.rotationDirection = Math.random() < 0.5 ? -1 : 1;
        this.rotationRemaining = 45 + Math.random() * 675;
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
        bullets.push(bullet);
    }

    fire() {
        if (--this.fireDelay <= 0) {
            this.shootBullet();
            this.state = TankState.MOVING;
        }
    }

    takeDamage(amount) {
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

        // Health bar (only draw if damaged)
        if (this.health < MAX_HEALTH) {
            const barWidth = this.size;
            const barHeight = 4;
            const barX = (x - barWidth / 2) | 0;
            const barY = (y + this.size / 2 + 5) | 0;

            ctx.fillStyle = '#333';
            ctx.fillRect(barX, barY, barWidth, barHeight);

            const healthPercent = this.health / MAX_HEALTH;
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
        const nearby = getNearbyEntities(this.x, this.y, TANK_SIZE);
        for (let i = 0; i < nearby.length; i++) {
            const tank = nearby[i];
            if (tank.id === this.ownerId || tank.state === TankState.DEAD) continue;

            const dx = this.x - tank.x;
            const dy = this.y - tank.y;
            const distSq = dx * dx + dy * dy;
            const hitDist = tank.size / 2 + this.size / 2;

            if (distSq < hitDist * hitDist) {
                tank.takeDamage(DAMAGE_PER_HIT);
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
        this.active = true;
        this.target = null;
        this.lifetime = 300; // Missiles explode after 5 seconds (60fps)
        this.trailParticles = [];
    }

    findTarget() {
        const nearby = getNearbyEntities(this.x, this.y, MISSILE_SEEK_RANGE);
        let closestTarget = null;
        let closestDist = MISSILE_SEEK_RANGE * MISSILE_SEEK_RANGE;

        for (let i = 0; i < nearby.length; i++) {
            const tank = nearby[i];
            if (tank.id === this.ownerId || tank.state === TankState.DEAD) continue;

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
        if (!this.target || this.target.state === TankState.DEAD) {
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
        const nearby = getNearbyEntities(this.x, this.y, TANK_SIZE);
        for (let i = 0; i < nearby.length; i++) {
            const tank = nearby[i];
            if (tank.id === this.ownerId || tank.state === TankState.DEAD) continue;

            const dx = this.x - tank.x;
            const dy = this.y - tank.y;
            const distSq = dx * dx + dy * dy;
            const hitDist = tank.size / 2 + 8;

            if (distSq < hitDist * hitDist) {
                tank.takeDamage(DAMAGE_PER_HIT * 2); // Missiles do double damage
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
    winner = null;
    gameRunning = true;
    frameCount = 0;

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
        tanks.push(new Tank(x, y, generateTankColor(i), i));
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

function checkWinner() {
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

function gameLoop() {
    frameCount++;

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

        checkWinner();
        updateUI();
    }

    // Draw
    drawArena();

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
    initGame();
}

function togglePause() {
    paused = !paused;
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
});

// Start
initGame();
gameLoop();
