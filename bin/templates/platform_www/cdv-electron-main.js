/*
    Licensed to the Apache Software Foundation (ASF) under one
    or more contributor license agreements.  See the NOTICE file
    distributed with this work for additional information
    regarding copyright ownership.  The ASF licenses this file
    to you under the Apache License, Version 2.0 (the
    "License"); you may not use this file except in compliance
    with the License.  You may obtain a copy of the License at

        http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing,
    software distributed under the License is distributed on an
    "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
    KIND, either express or implied.  See the License for the
    specific language governing permissions and limitations
    under the License.
*/

const fs = require('fs');
const path = require('path');
const { cordova } = require('./package.json');
// Module to control application life, browser window and tray.
const {
    app,
    BrowserWindow,
    protocol,
    ipcMain,
	session 
} = require('electron');
// Electron settings from .json file.
global.cdvElectronSettings = require('./cdv-electron-settings.json');

const reservedScheme = require('./cdv-reserved-scheme.json');

const devTools = cdvElectronSettings.browserWindow.webPreferences.devTools
    ? require('electron-devtools-installer')
    : false;

const scheme = cdvElectronSettings.scheme;
const hostname = cdvElectronSettings.hostname;
const deepLink = cdvElectronSettings.deepLink;
const isFileProtocol = scheme === 'file';
/**
 * The base url path.
 * E.g:
 * When scheme is defined as "file" the base path is "file://path-to-the-app-root-directory"
 * When scheme is anything except "file", for example "app", the base path will be "app://localhost"
 *  The hostname "localhost" can be changed but only set when scheme is not "file"
 */
const basePath = (() => isFileProtocol ? `file://${__dirname}` : `${scheme}://${hostname}`)();

if (reservedScheme.includes(scheme)) throw new Error(`The scheme "${scheme}" can not be registered. Please use a non-reserved scheme.`);

if (!isFileProtocol) {
    protocol.registerSchemesAsPrivileged([
        { scheme, privileges: { standard: true, secure: true } }
    ]);
}

// Keep a global reference of the window object, if you don't, the window will
// be closed automatically when the JavaScript object is garbage collected.
let mainWindow;
if (deepLink?.scheme) {
    if (process.defaultApp) {
        if (process.argv.length >= 2) {
            app.setAsDefaultProtocolClient(deepLink.scheme, process.execPath, [
                path.resolve(process.argv[1])
            ]);
        }
    } else {
        app.setAsDefaultProtocolClient(deepLink.scheme);
    }

    const gotTheLock = app.requestSingleInstanceLock();

    if (!gotTheLock) {
       return app.quit();
    } else {
        app.on('second-instance', (event, commandLine, workingDirectory) => {
            // Someone tried to run a second instance, we should focus our window.
            if (mainWindow) {
                if (mainWindow.isMinimized()) mainWindow.restore();
                mainWindow.focus();
                const url = commandLine.pop();
                mainWindow.webContents.executeJavaScript(`if(handleOpenURL)handleOpenURL("${url}");`);
            }
        });
    }
}

function createWindow () {
    // Create the browser window.
    let appIcon;
    if (fs.existsSync(path.join(__dirname, 'img/app.png'))) {
        appIcon = path.join(__dirname, 'img/app.png');
    } else if (fs.existsSync(path.join(__dirname, 'img/icon.png'))) {
        appIcon = path.join(__dirname, 'img/icon.png');
    } else {
        appIcon = path.join(__dirname, 'img/logo.png');
    }

    const browserWindowOpts = Object.assign({}, cdvElectronSettings.browserWindow, { icon: appIcon });
    browserWindowOpts.webPreferences.preload = path.join(app.getAppPath(), 'cdv-electron-preload.js');
    browserWindowOpts.webPreferences.contextIsolation = true;

    mainWindow = new BrowserWindow(browserWindowOpts);

    // Load a local HTML file or a remote URL.
    const cdvUrl = cdvElectronSettings.browserWindowInstance.loadURL.url;
    const loadUrl = cdvUrl.includes('://') ? cdvUrl : `${basePath}/${cdvUrl}`;
    const loadUrlOpts = Object.assign({}, cdvElectronSettings.browserWindowInstance.loadURL.options);

    mainWindow.loadURL(loadUrl, loadUrlOpts);

    // Open the DevTools.
    if (cdvElectronSettings.browserWindow.webPreferences.devTools) {
        if (cdvElectronSettings.browserWindow.webPreferences.showDevTools) {
            mainWindow.webContents.openDevTools();
        }
    }

    // Emitted when the window is closed.
    mainWindow.on('closed', () => {
    // Dereference the window object, usually you would store windows
    // in an array if your app supports multi windows, this is the time
    // when you should delete the corresponding element.
        mainWindow = null;
    });
}

function configureProtocol () {
    protocol.registerFileProtocol(scheme, (request, cb) => {
        const url = request.url.substr(basePath.length + 1);
        cb({ path: path.normalize(path.join(__dirname, url)) }); // eslint-disable-line node/no-callback-literal
    });

    protocol.interceptFileProtocol('file', (_, cb) => { cb(null); });
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', () => {
    if (!isFileProtocol) {
        configureProtocol();
    }

    if (devTools && cdvElectronSettings.devToolsExtension) {
        const extensions = cdvElectronSettings.devToolsExtension.map(id => devTools[id] || id);
        devTools.default(extensions) // default = install extension
            .then((name) => console.log(`Added Extension:  ${name}`))
            .catch((err) => console.log('An error occurred: ', err));
    }

	session.defaultSession.webRequest.onBeforeSendHeaders( async (details, callback) => {
        if (!details.url.startsWith("http://") || details.requestHeaders["Cookie"] ){
             callback({cancel: false});
             return;
        }
		const cookies = (await details.webContents.session.cookies.get({url:details.url})).map((cookie)=>{return `${cookie.name}=${cookie.value}; `}).reduce((accumulator, currentValue) => accumulator + currentValue, "");
		if(cookies)
            details.requestHeaders["Cookie"] = cookies;
		callback({cancel: false, requestHeaders: details.requestHeaders});
	});
	session.defaultSession.webRequest.onHeadersReceived( (details, callback) => {
        if ( details.url.startsWith("https://")){
            let nameSetCookie = 'Set-Cookie'
            if (details.responseHeaders['set-cookie']){
                nameSetCookie = 'set-cookie';
            }

            const cookies = details.responseHeaders[nameSetCookie];
            if(cookies) {
                const newCookie = Array.from(cookies)
                    .map(cookie => {
                        if ( cookie.indexOf("Secure") ===-1)
                            return cookie.concat('; SameSite=None; Secure')
                        else
                            return cookie;
                        });
                details.responseHeaders[nameSetCookie] = [...newCookie];
                callback({
                    responseHeaders: details.responseHeaders,
                });
            } else {
                callback({ cancel: false });
            }
        }else if ( details.url.startsWith("http://")){
            if ( details.responseHeaders[nameSetCookie]){
                const cookies=details.responseHeaders[nameSetCookie].map((d)=>d.split(';')[0].split("=")).map((d) => { return{ url: new URL(details.url).origin, name: d[0], value: d[1] }})
                cookies.map((cookie)=>{
                        details.webContents.session.cookies.set(cookie)
                        session.defaultSession.cookies.set(cookie);
                    })
            }
            callback({ cancel: false });

        }
        else{
            callback({ cancel: false });
        }
    });



    createWindow();
});

// Quit when all windows are closed.
app.on('window-all-closed', () => {
    // On OS X it is common for applications and their menu bar
    // to stay active until the user quits explicitly with Cmd + Q
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('browser-window-created', (e, win) => {
    win.setMenuBarVisibility(false)
});

app.on('activate', () => {
    // On OS X it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (mainWindow === null) {
        if (!isFileProtocol) {
            configureProtocol();
        }

        createWindow();
    }
});

ipcMain.handle('cdv-plugin-exec', async (_, serviceName, action, ...args) => {
    if (cordova && cordova.services && cordova.services[serviceName]) {
        const plugin = require(cordova.services[serviceName]);

        return plugin[action]
            ? plugin[action](args)
            : Promise.reject(new Error(`The action "${action}" for the requested plugin service "${serviceName}" does not exist.`));
    } else {
        return Promise.reject(new Error(`The requested plugin service "${serviceName}" does not exist have native support.`));
    }
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
