import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { setupScene } from './setup.js';
import { UIManager } from './ui.js';
import { Game } from './game.js';
import { ReplayRecorder } from './replay.js';
import { CanvasUI } from './canvas-ui.js';
import { AudioManager } from './audio.js';
import * as ScoreStorage from './score-storage.js';

// Global state
let game, ui, canvasUI, audioManager;
let scene, world, camera, renderer, uiScene, uiCamera, sky;
let skyScene, skyCamera;
let pendingSubmissions = []; // Track background submissions
let currentUser = null;
let currentUserProfile = null;

const room = new WebsimSocket();
const OLD_SCORE_COLLECTION = 'score_v1';
const USER_PROFILE_COLLECTION = 'user_profiles_v1';
const LEADERBOARD_MAX_SIZE = 1000;

async function init() {
    const {
        scene: s,
        world: w,
        camera: c,
        renderer: r,
        defaultMaterial: dm,
        uiScene: us,
        uiCamera: uc,
        sky: skyInstance,
        skyScene: ss,
        skyCamera: sc
    } = setupScene();
    scene = s;
    world = w;
    camera = c;
    renderer = r;
    uiScene = us;
    uiCamera = uc;
    sky = skyInstance;
    skyScene = ss;
    skyCamera = sc;

    ui = new UIManager();
    canvasUI = new CanvasUI(uiScene);
    audioManager = new AudioManager();
    audioManager.loadSound('place', 'block_place.mp3');
    audioManager.loadSound('fail', 'fail_sound.mp3');

    window.websim.getCurrentUser().then(async (user) => {
        currentUser = user;
        if (user) {
            await migrateUserScores();
        }
        syncLocalScores();
    });

    const gameCallbacks = {
        onScoreUpdate: (score) => {
            ui.updateScore(score);
            canvasUI.updateScore(score);
        },
        onStreakUpdate: (count, isGolden, isPerfectHit) => {
            ui.updateStreak(count, isGolden, isPerfectHit);
        },
        onGameOver: (score) => {
            const endedGameSession = {
                score,
                replayRecorder: game.getReplayRecorder(),
            };
            
            // Stop the recorder immediately to finalize the video
            endedGameSession.replayRecorder?.stop();

            ui.showGameOver(score);
            ui.setReplayButtonState(true, 'Preparing...');
            
            handleFinishedGame(endedGameSession);
        }
    };

    game = new Game(scene, world, dm, camera, gameCallbacks, audioManager);
    
    setupEventListeners();
    
    // Subscribe to the new user profile collection for the leaderboard
    room.collection(USER_PROFILE_COLLECTION).subscribe(profiles => {
        const sortedProfiles = profiles.sort((a, b) => (b.highScore || 0) - (a.highScore || 0));
        
        // Transform profiles into the format the UI expects
        const leaderboardScores = sortedProfiles.map(profile => {
            const highScoreData = profile.scores?.find(s => s.score === profile.highScore);
            return {
                username: profile.username,
                score: profile.highScore,
                replayUrl: highScoreData ? highScoreData.replayUrl : null,
            };
        });
        
        ui.updateLeaderboard(leaderboardScores, (replayUrl) => {
            ui.showReplayViewer(replayUrl);
        });

        if (currentUser) {
            currentUserProfile = profiles.find(p => p.username === currentUser.username) || null;
        }
    });

    renderer.setAnimationLoop(animate);
    startGame();
}

async function migrateUserScores() {
    if (!currentUser) return;
    
    const profiles = room.collection(USER_PROFILE_COLLECTION).getList();
    let userProfile = profiles.find(p => p.username === currentUser.username);

    if (userProfile) {
        currentUserProfile = userProfile;
        console.log("User profile already exists. No migration needed.");
        return;
    }

    const oldScores = room.collection(OLD_SCORE_COLLECTION).getList().filter(s => s.username === currentUser.username);

    if (oldScores.length > 0) {
        console.log(`Migrating ${oldScores.length} scores for user ${currentUser.username}...`);
        
        const newScoresArray = oldScores.map(s => ({
            score: s.score,
            replayUrl: s.replayUrl || null,
            timestamp: s.created_at
        })).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        
        const highScore = Math.max(...newScoresArray.map(s => s.score), 0);
        
        try {
            const newProfile = await room.collection(USER_PROFILE_COLLECTION).create({
                scores: newScoresArray,
                highScore: highScore
            });
            currentUserProfile = newProfile;
            console.log("Migration successful. New profile created.");

            // Clean up old scores after successful migration
            for (const oldScore of oldScores) {
                await room.collection(OLD_SCORE_COLLECTION).delete(oldScore.id);
            }
            console.log("Old scores cleaned up.");
        } catch (error) {
            console.error("Error during score migration:", error);
        }
    } else {
        console.log("No old scores found to migrate.");
    }
}

function startGame() {
    const newReplayRecorder = new ReplayRecorder(renderer.domElement, audioManager);
    game.start(newReplayRecorder);
    ui.hideGameOver();
    ui.showInstructions(true);
    canvasUI.updateScore(0);
}

function restart() {
    game.restart();
    startGame();
}

async function handleFinishedGame(session) {
    const { score, replayRecorder } = session;
    if (!replayRecorder) {
        autoSubmitScore(null, score, false);
        return;
    }

    const replayBlobPromise = replayRecorder.getReplayBlob();

    replayBlobPromise.then(blob => {
        ui.setReplayButtonState(false, 'Watch Replay', blob);
        autoSubmitScore(blob, score, true);
    }).catch(error => {
        console.error("Error getting replay blob:", error);
        ui.setReplayButtonState(false, 'Replay Failed');
        autoSubmitScore(null, score, false);
    });
}


async function autoSubmitScore(replayBlob, scoreToSubmit, hasReplay, localTempId = null) {
    if (hasReplay && (!replayBlob || replayBlob.size === 0) && !localTempId) {
        console.warn("Auto-submit cancelled: replay blob is invalid.");
        if (!ui.gameOverElement.classList.contains('hidden')) {
            ui.setSubmitStatus('Replay failed. Score not submitted.', '#f44336');
        }
        return;
    }

    const isResubmission = !!localTempId;
    let tempId = localTempId;

    if (!isResubmission && currentUser) {
        tempId = ScoreStorage.saveUserScore(currentUser.username, {
            score: scoreToSubmit,
            replayUrl: null,
            timestamp: Date.now()
        });
    }

    // Add visual indicator to trophy button
    const leaderboardButton = document.getElementById('leaderboard-button');
    leaderboardButton.classList.add('uploading');
    leaderboardButton.textContent = '⏳';

    const submissionPromise = (async () => {
        let isScoreSubmitted = false;
        try {
            const userForSubmission = currentUser || await window.websim.getCurrentUser();
            if (!userForSubmission) {
                throw new Error('Could not get user info for submission.');
            }
            if (!currentUser) currentUser = userForSubmission;
            
            // Wait for any pending migration to complete before proceeding
            await new Promise(resolve => setTimeout(resolve, 500)); 

            const allProfiles = room.collection(USER_PROFILE_COLLECTION).getList();
            
            // --- Leaderboard Cap Logic ---
            if (allProfiles.length >= LEADERBOARD_MAX_SIZE) {
                const lowestHighScore = allProfiles.reduce((min, p) => (p.highScore || 0) < min ? p.highScore : min, Infinity);
                if (scoreToSubmit <= lowestHighScore) {
                    console.log('Score too low for full leaderboard.');
                    if (!ui.gameOverElement.classList.contains('hidden') && !isResubmission) {
                        ui.setSubmitStatus(`Score must be > ${lowestHighScore} to make the leaderboard.`, '#ff9800');
                    }
                    if (tempId) ScoreStorage.removeUserScore(currentUser.username, tempId);
                    return;
                }
            }

            const userProfile = currentUserProfile;
            const newScoreEntry = {
                score: scoreToSubmit,
                replayUrl: null,
                timestamp: new Date().toISOString()
            };

            // If the user has a score and the new one isn't higher, we still record it, but UI message differs.
            const isNewHighScore = !userProfile || scoreToSubmit > (userProfile.highScore || 0);
            if (!isNewHighScore && !isResubmission) {
                console.log('Score not higher than user\'s best.');
                if (!ui.gameOverElement.classList.contains('hidden')) {
                    ui.setSubmitStatus('Not a new high score.', '#ff9800');
                }
            }
            
            let replayUrl = null;
            if (hasReplay && replayBlob) {
                try {
                    replayUrl = await window.websim.upload(replayBlob);
                    if (!replayUrl) throw new Error('Upload returned invalid URL');
                    
                    const response = await fetch(replayUrl, { method: 'HEAD' });
                    if (!response.ok) throw new Error('Uploaded file not accessible');
                    if (tempId) ScoreStorage.updateUserScore(currentUser.username, tempId, { replayUrl });
                    newScoreEntry.replayUrl = replayUrl;

                } catch (uploadError) {
                    console.error("Replay upload failed:", uploadError);
                     if (!ui.gameOverElement.classList.contains('hidden') && !isResubmission) {
                        ui.setSubmitStatus('Replay upload failed. Score not submitted.', '#f44336');
                    }
                    if (tempId) ScoreStorage.removeUserScore(currentUser.username, tempId);
                    return; 
                }
            } else if (isResubmission) {
                const localData = ScoreStorage.getUserScores(currentUser.username).find(s => s.tempId === tempId);
                if (localData && localData.replayUrl) {
                    replayUrl = localData.replayUrl;
                    newScoreEntry.replayUrl = replayUrl;
                }
            }

            if (hasReplay && !newScoreEntry.replayUrl && !isResubmission) {
                console.error('Replay upload seems to have failed silently.');
                if (!ui.gameOverElement.classList.contains('hidden')) {
                    ui.setSubmitStatus('Replay upload incomplete. Score not submitted.', '#f44336');
                }
                if (tempId) ScoreStorage.removeUserScore(currentUser.username, tempId);
                return;
            }

            if (!ui.gameOverElement.classList.contains('hidden') && !isResubmission) {
                 ui.setSubmitStatus(isNewHighScore ? 'Saving new high score...' : 'Saving score...', '#ff9800');
            }

            if (userProfile) {
                const updatedScores = [newScoreEntry, ...(userProfile.scores || [])];
                const newHighScore = Math.max(scoreToSubmit, userProfile.highScore || 0);

                await room.collection(USER_PROFILE_COLLECTION).update(userProfile.id, {
                    scores: updatedScores,
                    highScore: newHighScore
                });

                if (!ui.gameOverElement.classList.contains('hidden') && !isResubmission) {
                    ui.setSubmitStatus(isNewHighScore ? 'High score updated!' : 'Score saved!', '#4CAF50');
                }
            } else {
                await room.collection(USER_PROFILE_COLLECTION).create({
                    scores: [newScoreEntry],
                    highScore: scoreToSubmit
                });
                if (!ui.gameOverElement.classList.contains('hidden') && !isResubmission) {
                    ui.setSubmitStatus('High score submitted!', '#4CAF50');
                }
            }
            isScoreSubmitted = true;
            if (tempId) ScoreStorage.removeUserScore(currentUser.username, tempId);

        } catch (error) {
            console.error("Failed to auto-submit score:", error);
            if (!ui.gameOverElement.classList.contains('hidden') && !isResubmission) {
                ui.setSubmitStatus('Error submitting score.', '#f44336');
            }
        } finally {
            if (isScoreSubmitted) {
                leaderboardButton.classList.remove('uploading');
                leaderboardButton.classList.add('upload-complete');
                leaderboardButton.textContent = '✅';
                
                setTimeout(() => {
                    leaderboardButton.classList.remove('upload-complete');
                    leaderboardButton.textContent = '🏆';
                }, 3000);
            } else {
                 leaderboardButton.classList.remove('uploading');
                 leaderboardButton.textContent = '🏆';
            }
        }
    })();

    pendingSubmissions.push(submissionPromise);
    submissionPromise.finally(() => {
        const index = pendingSubmissions.indexOf(submissionPromise);
        if (index > -1) {
            pendingSubmissions.splice(index, 1);
        }
    });
}

async function syncLocalScores() {
    if (!currentUser) return;

    const localScores = ScoreStorage.getUserScores(currentUser.username);
    if (localScores.length === 0) return;

    console.log(`Found ${localScores.length} local scores to check.`);

    const userProfile = currentUserProfile;
    const dbScores = userProfile ? userProfile.scores || [] : [];

    for (const localScore of localScores) {
        // A simple check: if a score with the exact value and replay URL exists, assume it's synced.
        const isSynced = dbScores.some(dbScore =>
            dbScore.score === localScore.score &&
            (!localScore.replayUrl || dbScore.replayUrl === localScore.replayUrl)
        );

        if (!isSynced) {
            console.log(`Resubmitting local score: ${localScore.score}`);
            // Resubmit. This uses the autoSubmit logic which includes all checks.
            // We pass null for the blob because we can't store it, but we have the URL.
            const hasReplay = !!localScore.replayUrl;
            autoSubmitScore(null, localScore.score, hasReplay, localScore.tempId);
        } else {
            // It's on the server, so we can clean it up locally.
            ScoreStorage.removeUserScore(currentUser.username, localScore.tempId);
        }
    }
}

async function viewReplay() {
    const blob = ui.getCurrentReplayBlob();
    if (!blob) {
        alert("Replay not available or still processing.");
        return;
    }

    ui.setReplayButtonState(true, 'Loading...');
    try {
        ui.showReplayViewer(blob);
    } catch (error) {
        console.error("Error viewing replay:", error);
        alert("Could not load replay.");
    } finally {
        ui.setReplayButtonState(false, 'Watch Replay', blob);
    }
}

async function submitScore() {
    // This function is no longer used and can be removed or left empty.
    // For safety, we'll just log that it was called.
    console.log("submitScore called, but functionality is now in autoSubmitScore.");
}

function setupEventListeners() {
    ui.setupEventListeners({
        onPointerDown: () => {
            audioManager.unlockAudio();
            if (game.getState() === 'playing') {
                ui.showInstructions(false);
                game.onPointerDown();
            }
        },
        onRestart: restart,
        onViewReplay: viewReplay,
        onViewLeaderboard: () => ui.showLeaderboard(),
        onCloseLeaderboard: () => {
            ui.hideLeaderboard();
            const gameState = game.getState();
            if (gameState === 'gameover') {
                ui.showGameOver(game.getScore());
            } else if (gameState !== 'playing') {
                restart();
            }
            // If game is 'playing', do nothing extra, just hide the leaderboard.
        },
        onWindowResize: () => {
            const aspect = window.innerWidth / window.innerHeight;
            const frustumSize = 4;
            camera.left = frustumSize * aspect / -2;
            camera.right = frustumSize * aspect / 2;
            camera.top = frustumSize / 2;
            camera.bottom = frustumSize / -2;
            camera.updateProjectionMatrix();
            renderer.setSize(window.innerWidth, window.innerHeight);

            uiCamera.left = -window.innerWidth / 2;
            uiCamera.right = window.innerWidth / 2;
            uiCamera.top = window.innerHeight / 2;
            uiCamera.bottom = -window.innerHeight / 2;
            uiCamera.updateProjectionMatrix();
            canvasUI.onWindowResize();
        }
    });

    window.addEventListener('beforeunload', (event) => {
        if (pendingSubmissions.length > 0) {
            event.preventDefault();
            event.returnValue = ''; // For Chrome
            return "Your score is still uploading. Are you sure you want to leave?"; // For older browsers
        }
    });
}

function animate() {
    world.step(1 / 60);
    game.update();
    sky.update();
    
    renderer.clear();

    // Render sky first with its own camera
    renderer.render(skyScene, skyCamera);

    // Render game scene
    renderer.render(scene, camera);

    renderer.clearDepth();
    renderer.render(uiScene, uiCamera);
}

init();