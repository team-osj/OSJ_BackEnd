const credential = require('./var.js');
const serAccount = require('./firebase_token.json')
const express = require('express')
const cors = require('cors')
const mysql = require('mysql');
const fcm = require('firebase-admin')
const fs = require('fs');
const moment = require("moment");
const schedule = require('node-schedule');
const bodyParser = require("body-parser");
const auth = require('basic-auth');
const rateLimit = require('express-rate-limit');
const url = require('url');

const { Client, IntentsBitField } = require('discord.js');
const client = new Client({
    intents: [
        IntentsBitField.Flags.Guilds,
        IntentsBitField.Flags.GuildMembers,
        IntentsBitField.Flags.GuildMessages,
        IntentsBitField.Flags.MessageContent,
    ],
});

const app = express()
app.use(cors({
    origin: '*',
}));
app.use(rateLimit({ 
    windowMs: 1*60*1000, 
    max: 100 
    })
);
app.set('trust proxy', 1)
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

require('console-stamp')(console, 'yyyy/mm/dd HH:MM:ss.l');

const options = {
    key: fs.readFileSync('./privkey.pem'),
    cert: fs.readFileSync('./cert.pem')
};

const https = require('https').createServer(options, app);
const http = require('http').createServer(app)

const http_port = 80
const https_port = 443

const wsModule = require('ws');

const ClientSocket = new wsModule.Server(
    {
        noServer: true
    }
);

const DeviceSocket = new wsModule.Server(
    {
        noServer: true
    }
);

var ConnectedDevice = [];

function heartbeat() {
    this.isAlive = true;
}

fcm.initializeApp({
    credential: fcm.credential.cert(serAccount),
})

const connection = mysql.createConnection({
    host: credential.mysql_host,
    user: credential.mysql_user,
    password: credential.mysql_pw,
    database: credential.mysql_db
});

client.on('messageCreate', (message) => {
    if (message.author.bot) {
        return;
    }
});

client.on('interactionCreate', (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === '상태변경') {
        const device_no = interaction.options.get('first-number').value;
        const device_status = interaction.options.get('second-number').value;
        console.log("[Discord] Status Updated Device_NO:" + device_no + " Data:" + device_status);
        StatusUpdate(device_no,device_status)
        return interaction.reply('OK');
    }
});

client.on('ready', (c) => {
    console.log(`${c.user.tag} is online.`);
});

client.login(credential.discord_token);

https.on('upgrade', function upgrade(request, socket, head) {
    const { pathname } = url.parse(request.url);
    const user = auth(request);
    if (pathname === '/client') {
        ClientSocket.handleUpgrade(request, socket, head, function done(ws) {
            ClientSocket.emit('connection', ws, request);
        });
    } else if(pathname === '/device')
    {
        if (!user || user.name !== credential.auth_name || user.pass !== credential.auth_pw) {
            socket.destroy();
        } else {
            console.log(`[Device][Connected] [${request.headers['sec-websocket-key']},${request.headers['hwid']},${request.headers['ch1']},${request.headers['ch2']}]`);
            const channel = client.channels.cache.get(credential.discord_channelid);
            channel.send(`장치가 연결되었습니다. [${request.headers['sec-websocket-key']}, HWID : "${request.headers['hwid']}", CH1 : "${request.headers['ch1']}", CH2 : "${request.headers['ch2']}"]`);
            let DeviceObject = new Object();
            DeviceObject.ws_key = request.headers['sec-websocket-key'];
            DeviceObject.hwid = request.headers['hwid'];
            DeviceObject.ch1 = request.headers['ch1'];
            DeviceObject.ch2 = request.headers['ch2'];
            ConnectedDevice.push(DeviceObject);
            DeviceSocket.handleUpgrade(request, socket, head, function done(ws) {
                DeviceSocket.emit('connection', ws, request);
            });
        }
    }
    else {
        socket.destroy();
    }
});

ClientSocket.on('connection', (ws, request) => {//클라이언트 Websocket
    if (ws.readyState === ws.OPEN) {
        ws.send(`Hello From Server`);
    }
    ws.on('close', () => {
        //console.log(`Websocket[${request.headers['sec-websocket-key']}] closed`);
    })
});

DeviceSocket.on('connection', (ws, request) => {//장치 Websocket
    //console.log(request.headers);
    ws.isAlive = true;
    ws.on('pong', heartbeat);
    if (ws.readyState === ws.OPEN) {
    }

    ws.on('message', (msg) => {
        const device_data = JSON.parse(msg)
        console.log("[Device] ID: " + device_data.id + " Status: " + device_data.state)
        StatusUpdate(device_data.id,device_data.state)
    })

    ws.on('close', () => {
        console.log(`[Device][Disconnected] [${request.headers['sec-websocket-key']}]`);
        const channel = client.channels.cache.get(credential.discord_channelid);
        channel.send(`장치의 연결이 끊어졌습니다. [${request.headers['sec-websocket-key']}, HWID : "${request.headers['hwid']}", CH1 : "${request.headers['ch1']}", CH2 : "${request.headers['ch2']}"]<@&${credential.discord_roleid}>`);
        ConnectedDevice.splice(ConnectedDevice.findIndex(obj => obj.ws_key == request.headers['sec-websocket-key']), 1);
    })
});

const interval = setInterval(function ping() {//장치 Heartbeat
    DeviceSocket.clients.forEach(function each(ws) {
        if (ws.isAlive === false) return ws.terminate();
        console.log("ping");
        ws.isAlive = false;
        ws.ping();
    });
}, 20000);

app.get('/', (req, res) => {
    res.sendStatus(200)
})

app.get("/device_list", (req, res) => {//장치 목록
    connection.query(`SELECT * FROM deviceStatus;`, function (error, results) {
        if (error) {
            console.log('SELECT * FROM deviceStatus query error:');
            console.log(error);
            return;
        }
        res.send(results)
        //console.log('==============================================')
    });
});

app.post("/push_request", (req, res) => {//알림 신청 기능
    let token = req.body.token;
    let device_id = req.body.device_id;
    let expect_state = req.body.expect_state;
    console.log("[App] Push Request Device Token: " + token + " Device ID: " + device_id + " Expect Status: " + expect_state)

    //DB에 중복되는 값 있는지 확인
    connection.query(`SELECT Token FROM PushAlert WHERE device_id = ? AND Expect_Status = ? AND Token = ?;`, [device_id, expect_state, token], function (error, results) {
        let type = new Array();
        if (error) {
            console.log('SELECT Token query error:');
            console.log(error);
            return;
        }

        //중복이면 return
        if (results.length > 0) {
            res.status(304).send('이미 신청된 장치입니다.')
            return;
        } else {//중복 아니면 DB에 Token 등록
            connection.query(`SELECT device_type FROM deviceStatus WHERE id = ?;`, [device_id], function (error, type_results) {
                if (error) {
                    console.log('SELECT device_type query error:');
                    console.log(error);
                    return;
                }

                connection.query(`INSERT INTO PushAlert (Token, device_id, Expect_Status, device_type) VALUES (?, ?, ?, ?);`, [token, device_id, expect_state, type_results[0].device_type], (error, results) => {
                    if (error) {
                        console.log('deviceStatus Update query error:');
                        console.log(error);
                        return;
                    }
                    //console.log(results);
                    res.status(200).send('알림 신청 성공.')
                });
            });

        }
    });
});

app.post("/push_list", (req, res) => {//알림 신청 목록 확인 기능
    let token = req.body.token;
    console.log("[App] Push List Request Device Token: " + token)

    connection.query(`SELECT device_id, device_type, state FROM PushAlert WHERE Token = ? ORDER BY device_id;`, [token], function (error, results) {
        if (error) {
            console.log('SELECT Token query error:');
            console.log(error);
            return;
        }
        res.send(results)
        //console.log(results);
    });
});

app.post("/push_cancel", (req, res) => {//알림 취소 기능
    let token = req.body.token;
    let device_id = req.body.device_id;
    console.log("[App] Push Cancel Request Device Token: " + token + " Device ID: " + device_id)

    connection.query(`DELETE FROM PushAlert WHERE device_id = ? AND Token = ?;`, [device_id, token], function (error, results) {
        if (error) {
            console.log('SELECT Token query error:');
            console.log(error);
            return;
        }

        connection.query(`SELECT device_id, device_type FROM PushAlert WHERE Token = ? ORDER BY device_id;`, [token], function (error, results) {
            if (error) {
                console.log('SELECT Token query error:');
                console.log(error);
                return;
            }
            res.send(results)
        });
    });

});

http.listen(http_port, () => {
    console.log(`Listening to port ${http_port}`)
})

https.listen(https_port, () => {
    console.log(`Listening to port ${https_port}`)
})

function StatusUpdate(id,state) {
    let device_status_str
    if(state == 1)
    {
        device_status_str = "사용가능"
    }else if(state == 0){
        device_status_str = "작동중"
    }
    const channel = client.channels.cache.get(credential.discord_channelid);
    channel.send(`${id}번 기기의 상태가 ${device_status_str}으로 변경되었습니다.`);
    //Gateway에서 Socket.io로 넘어온 값 DB에 넣기
    connection.query(`UPDATE deviceStatus SET state = ? WHERE id = ?;`, [state, id], (error, results) => {
        if (error) {
            console.log('deviceStatus Update query error:');
            console.log(error);
            return;
        }
        //console.log(results);
    });

    connection.query(`UPDATE PushAlert SET state = ? WHERE device_id = ?;`, [state, id], (error, results) => {
        if (error) {
            console.log('deviceStatus Update query error:');
            console.log(error);
            return;
        }
        //console.log(results);
    });

    //Application과 Frontend에 현재 상태 DB 넘기기
    connection.query(`SELECT * FROM deviceStatus WHERE id = ?;`, [id],function (error, results) {
        if (error) {
            console.log('SELECT * FROM deviceStatus query error:');
            console.log(error);
            return;
        }
        ClientSocket.clients.forEach(function (client) {
            client.send(JSON.stringify(results));
        });
    });

    if (state == 0)//ON
    {
        connection.query(`UPDATE deviceStatus SET ON_time = ? WHERE id = ?;`, [moment().format(), id], (error, results) => {
            if (error) {
                console.log('deviceStatus Update query error:');
                console.log(error);
                return;
            }
            //console.log(results);
        });
    } else {//OFF
        connection.query(`UPDATE deviceStatus SET OFF_time = ? WHERE id = ?;`, [moment().format(), id], (error, results) => {
            if (error) {
                console.log('deviceStatus Update query error:');
                console.log(error);
                return;
            }

            connection.query(`SELECT ON_time, OFF_time FROM deviceStatus WHERE id = ?;`, [id], function (error, results) {
                if (error) {
                    console.log('SELECT Token query error:');
                    console.log(error);
                    return;
                }
                let hour_diff = moment(results[0].OFF_time).diff(results[0].ON_time, 'hours')
                let minute_diff = moment(results[0].OFF_time).diff(results[0].ON_time, 'minutes') - (hour_diff * 60)
                let second_diff = moment(results[0].OFF_time).diff(results[0].ON_time, 'seconds') - (minute_diff * 60) - (hour_diff * 3600)
                console.log("[Device] Time " + hour_diff + "/" + minute_diff + "/" + second_diff)

                //Gateway에서 Socket.io로 넘어온 값에 등록된 Token 조회해서 FCM 보내기
                connection.query(`SELECT Token FROM PushAlert WHERE device_id = ? AND Expect_Status = ?;`, [id, state], function (error, results) {
                    let target_tokens = new Array();
                    if (error) {
                        console.log('SELECT Token query error:');
                        console.log(error);
                        return;
                    }
                    //console.log(results);
                    //console.log(results.length);

                    //해당되는 Token 배열형태로 저장
                    for (let i = 0; i < results.length; i++) {
                        target_tokens[i] = results[i].Token;
                    }


                    //해당되는 Token이 없다면 return
                    if (target_tokens == 0) {
                        console.log("[FCM] No push request (" + id + ")");
                        return
                    } else {
                        console.log("[FCM] Push Sent");
                        console.log("[FCM] " + target_tokens);

                        connection.query(`SELECT device_type FROM deviceStatus WHERE id = ?;`, [id], function (error, results) {
                            if (results[0].device_type == "WASH") {
                                //FCM 메시지 내용
                                let message = {
                                    notification: {
                                        title: '세탁기 알림',
                                        body: `${id}번 세탁기의 동작이 완료되었습니다.\r\n동작시간 : ${hour_diff}시간 ${minute_diff}분 ${second_diff}초`,
                                    },
                                    tokens: target_tokens,
                                    android: {
                                        priority: "high"
                                    },
                                    apns: {
                                        payload: {
                                            aps: {
                                                contentAvailable: true,
                                            }
                                        }
                                    }
                                }

                                //FCM 메시지 보내기
                                fcm.messaging().sendMulticast(message)
                                    .then((response) => {
                                        if (response.failureCount > 0) {
                                            const failedTokens = [];
                                            response.responses.forEach((resp, idx) => {
                                                if (!resp.success) {
                                                    failedTokens.push(target_tokens[idx]);
                                                }
                                            });
                                            console.log('[FCM] Failed Token: ' + failedTokens);
                                        }
                                        //console.log('FCM Success')
                                        return
                                    });
                            } else if (results[0].device_type == "DRY") {
                                //FCM 메시지 내용
                                let message = {
                                    notification: {
                                        title: '건조기 알림',
                                        body: `${id}번 건조기의 동작이 완료되었습니다.\r\n동작시간 : ${hour_diff}시간 ${minute_diff}분 ${second_diff}초`,
                                    },
                                    tokens: target_tokens,
                                    android: {
                                        priority: "high"
                                    },
                                    apns: {
                                        payload: {
                                            aps: {
                                                contentAvailable: true,
                                            }
                                        }
                                    }
                                }

                                //FCM 메시지 보내기
                                fcm.messaging().sendMulticast(message)
                                    .then((response) => {
                                        if (response.failureCount > 0) {
                                            const failedTokens = [];
                                            response.responses.forEach((resp, idx) => {
                                                if (!resp.success) {
                                                    failedTokens.push(target_tokens[idx]);
                                                }
                                            });
                                            console.log('[FCM] Failed Token:' + failedTokens);
                                        }
                                        //console.log('FCM Success')
                                        return
                                    });

                            }
                        });

                    }
                });

                //FCM 메시지 보낸 Token 제거
                connection.query(`DELETE FROM PushAlert WHERE device_id = ? AND Expect_Status = ?;`, [id, state], function (error, results) {
                    if (error) {
                        console.log('DELETE Token query error:');
                        console.log(error);
                        return;
                    }
                    //console.log(results);
                });
            })
        });
    }

}