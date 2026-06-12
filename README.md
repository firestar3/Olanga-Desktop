# Olanga Voice Assistant

Olanga is a completely hands-free, full-screen desktop AI voice assistant. Built on Electron, it runs silently in your system tray and listens for a wake word using a completely offline, local speech recognition model (Vosk). Once awakened, it leverages Google Gemini 2.5 for incredibly fast intelligence and multimodal vision, and NVIDIA's advanced Magpie models for hyper-realistic text-to-speech.

## Features

- **Local Wake Word:** Always-on listening without streaming your mic to the cloud. Olanga waits for you to say *"Hey"* before activating.
- **Multimodal Vision:** Olanga can literally look at your screen! If you ask about an error, an image, or anything visual, Olanga will instantly pop open your native Windows Snipping tool so you can select an area for it to analyze.
- **Deep System Integrations:** Control your computer with your voice. Olanga interfaces directly with Windows PowerShell to skip songs, change volume, open apps, and interact with the Spotify Desktop App.
- **Background Execution:** Minimizes seamlessly to your Windows System Tray and keeps listening. 

## Installation

Assuming you have cloned this repository from GitHub:

1. **Prerequisites**: Make sure you have [Node.js](https://nodejs.org/) installed.
2. **Install Dependencies**:
   ```bash
   npm install
   ```
3. **Start the App**:
   ```bash
   npm start
   ```

## Setup & API Keys

On your first launch, Olanga will ask for your API keys. You can access these anytime by clicking the **Settings (gear)** icon in the top right.

1. **Gemini API Key**: Required for the core intelligence and vision model. Get one for free at [aistudio.google.com](https://aistudio.google.com/apikey).
2. **NVIDIA API Key**: Required for the Magpie TTS (Text-to-Speech) voice. Get one at [build.nvidia.com](https://build.nvidia.com/). If you do not provide an NVIDIA key, Olanga will automatically fallback to your browser's default voice.
3. **Location Context**: Add your City/State in the settings so Olanga can provide accurate real-time weather and local searches.

## Voice Commands & Capabilities

To start an interaction, simply say: **"Hey"** (or similar variations like "Hey Olanga") and wait for the UI to turn green and pulse.

### General Intelligence & Search
- Ask anything: *"What's the capital of France?"*
- Real-time info: *"What's the weather like today?"*, *"Who won the game last night?"*

### Multimodal Vision
- *"Look at my screen, why am I getting this code error?"*
- *"Can you read this paragraph for me?"*
*(Olanga will trigger your snipping tool. Select the area, and Olanga will process the image along with your original question!)*

### Spotify Control
*(Note: Olanga simulates keystrokes to control the actual Spotify Desktop App. Make sure Spotify is open.)*
- **Songs**: *"Play Shape of You by Ed Sheeran on Spotify"*
- **Artists**: *"Play Drake on Spotify"*
- **Playlists**: *"Play my Liked Songs"*

### Media & Volume Controls
- **Playback**: *"Pause the music"*, *"Resume playback"*
- **Tracks**: *"Skip to the next song"*, *"Go back to the previous track"*
- **Volume**: *"Turn the volume up"*, *"Turn it down"*, *"Mute the audio"*

### App Launching
*(Olanga integrates directly with Windows Search to launch applications.)*
- *"Open Discord"*
- *"Launch Google Chrome"*
- *"Start Microsoft Word"*

## Troubleshooting

- **App won't start after closing it?** Olanga is designed to stay alive in your system tray (bottom right corner of Windows). If you try to open a second instance while it's hidden, it will just bring the hidden window back into focus. To completely close Olanga, right-click the orb in your system tray and click "Quit".
- **Audio isn't playing / Vision isn't working?** Check the Developer Console (`Ctrl+Shift+I` while Olanga is focused) for specific rate-limit or API key errors.

## Application Photo

<img width="2559" height="1439" alt="image" src="https://github.com/user-attachments/assets/77a8d0f5-be6a-439a-bb75-b1fd3a91c798" />
<img width="2557" height="1439" alt="image" src="https://github.com/user-attachments/assets/c72cd236-f7a1-492a-8f40-a2231f415092" />
<img width="2557" height="1439" alt="image" src="https://github.com/user-attachments/assets/f460ae8a-1288-41c0-b062-5c5adc4aeec3" />
<img width="2559" height="1439" alt="image" src="https://github.com/user-attachments/assets/7959e695-0d5e-4da6-9d08-be18c72ff153" />



