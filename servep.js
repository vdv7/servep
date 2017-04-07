#!/usr/bin/env node

////////////////////////////////////
// Process Server
//	this script will serve standard console processes over a standard TCP socket, a websocket connection, or via a stateful http session
//
//
// TODO:
//	make _tcp folder and add capability to read/add it; or change _ws to _wstcp?
//	allow changes in HTTP_CONNECTION_TIMEOUT, auto-tcp port range, and timeout for res.end via cli
//	add help documentation (e.g. example interactions over netcat, curl, and wscat, requirement to flush, CDE protocol, session-id redirects, log format, only 3 http req's per processID, etc)
//	adapt to each process so as to get rid of http res.end timeout if that timeout isn't needed
//	add security in http by recording/checking ip address (and maybe headers?) for each processID,
//	add https/wss


const
	WS_FOLDER = '_ws',
	HTTP_FOLDER = '_http',
	HTTP_CONNECTION_TIMEOUT = 600000, //10min
	AUTO_TCP_PORT = 9000
;


////////////////////////////////////////
// usage and help
const DESCRIPTION="This script serves stdio executables over TCP, HTTP, or WebSockets.";
const USAGE=`Usage: servep [ServeFolder] [Options or Extensions]

  ServeFolder:              path to a folder optionally containing
                              - static files to serve over http (e.g. html)
                              - ${HTTP_FOLDER}/ folder containing stdio scripts 
                                and executables to be served over http
                              - ${WS_FOLDER}/ folder containing stdio scripts
                                and executables to be served over ws
  Options:
    --help                  more detailed help text
    -p, --port PORT         serve http/ws processes and static files on PORT;
                            if this argument is not specified, default is 80
    -t, --tcp ExeFolder     serve processes in ExeFolder over TCP
    -t, --tcp "[Port:]Exe"  serve Exe over TCP, on a specified Port
                            (this argument may be specified multiple times)
    -w, --ws ExeFolder      serve processes in ExeFolder over websockets
    -w, --ws "[Name:]Exe"   serve Exe over websockets, route by specified Name
                            (this argument may be specified multiple times)
    -h, --http ExeFolder    serve processes in ExeFolder over http
    -h, --http "[Name:]Exe" serve Exe over http, route by specified Name
                            (this argument may be specified multiple times)
    -l, --logpath path      log all server-client interactions in separate
                              files in the specified path, under subfolder
                              PROTOCOL/ROUTE/, where PROTOCOL is http, ws, or
                              tcp, and ROUTE is the respective Port or Name
  Extensions:               filename extension preceeded by "--" and followed
                              by path to interpreter for that filetype, e.g.:
                               --py python3 --js node
  ExeFolder:                path to folder including stdio scripts/processes
  Exe:                      path to stdio script/process [and arguments]
`;
const HELP=`
[Bug fixes and features requests: https://github.com/vdv7/servep/issues]

Each new TCP or WS connection to server will spawn a new process, and pipe
socket-out to std-in, and std-out to socket-in.

HTTP requests without a session-id are redirected, so as to include unique
session-id. Each new session-id is tied to a newly spawned process. Data in
each HTTP request with a session-id is routed to its respective process 
std-in, and the HTTP response is generated from that process' std-out.

  HTTP requests adhere to the CDE (callback/data/end) protocol, i.e.:

    JSONP requests are enabled by adding GET parameter "callback" or GET
      parameter "c"
    all input to server-side process is passed in POST method body, or
      as the value for GET parameter "data" or GET parameter "d"
    adding GET parameter "end" or GET parameter "e" to an HTTP request
      gracefully ends the current session

    example of simple echo process interaction:

      client GET request: http://localhost:8000/myapp?c=process&d=hello
      server response body: http://localhost:8000/myapp:xxx?c=process&d=hi
        (where xxx is the session id)
      client GET request: http://localhost:8000/myapp:xxx?c=process&d=hi
      server response body: "you said: hello"
      client GET request: http://localhost:8000/myapp:xxx?e
      server closes the running echo process and responds with status 204


Examples:
  servep -p 8000 --http "hi:echo hi" --ws "hi:echo hi" --tcp "8001:echo hi"
  (will serve process "echo hi" at http://localhost:8000/hi, 
    ws://localhost:8000/hi, and on tcp without any headers on port 8001)

  servep -p 8000 --http samples/_http/ --py python3
  (will serve all executables from samples/_http folder, as well as any
    python3 scripts that have a .py extension. if samples/_http includes
    helloecho.py, it will be served at http://localhost:8000/helloecho.py)

`;


////////////////////////////////////////
// load modules
const childProcess = require('child_process'),
	CreateTcpServer=require('net').createServer,
	Http = require('http'),
	WebSocket = require('ws'),
	fs=require('fs'),
	path=require('path'),
	url = require('url'),
	argParser=require('minimist'),
	moment=require('moment');

const WIN=process.env.comspec && process.env.comspec.search("cmd.exe")>-1;



////////////////////////////////////////
// global vars
var clArgs,httpServer,wsServer,spawnedProcesses=[],tcpPort=AUTO_TCP_PORT;

////////////////////////////////////////
// supporting functions
String.prototype.replaceAll=function(s1,s2){return this.replace(new RegExp(s1, 'g'), s2);}
function exeExists(exe){
	var p;
	if(WIN)p=childProcess.spawnSync(process.env.comspec,['/c'].concat(['where',exe]));
	else p=childProcess.spawnSync('which',[exe]);
	return p.status===0;
}
function mkdir(pathname) {
	try {fs.mkdirSync(pathname);}
	catch(e){if(e.code!='EEXIST')throw e;}
}
function tightJSON(s){
	try{  //if s is JSON, try tightening it
		return JSON.stringify(JSON.parse(s));
	}catch(e){ //if s is not JSON, put quotes around it, backslashes before special chars
		return JSON.stringify(s);
	}
}

////////////////////////////////////////
// logging
function print(s){console.log(s);}
function status(taskinfo,status,comment,now){
	print(`${(now||moment()).format('YYYY-MM-DD HH:mm:ss')}\t${taskinfo}\t${status||'-'}\t${comment||'-'}`);
}
function makeLogFolder(task){
	mkdir(clArgs.log);
	mkdir(path.join(clArgs.log,task.protocol));
	mkdir(path.join(clArgs.log,task.protocol,task.route));
}
function openLog(taskprocess,startTime){
	if(clArgs.log){
		taskprocess.log=fs.createWriteStream(path.join(clArgs.log,taskprocess.protocol,taskprocess.route,taskprocess.processID+'.txt'));
		taskprocess.log.write(`epochms	cs-body	sc-body\n`);
	}
}
function record2log(logfile,csdata,scdata){
	if(logfile)logfile.write(`${new Date().getTime()}	${csdata?tightJSON(csdata):'-'}	${scdata?tightJSON(scdata):'-'}\n`);
}

////////////////////////////////////////
// local process setup/teardown
function run(cmd){
	if(WIN)return childProcess.spawn(process.env.comspec,['/c'].concat(cmd));
	return childProcess.spawn(cmd[0],cmd.slice(1));
}
function setupProcess(task,ip){
	//TODO: tie processID with logfile name
	var p=run(task.args);
	spawnedProcesses.push(p);
	p.protocol=task.protocol;
	p.port=task.port||clArgs.port;
	p.route=task.route;
	p.cmd=task.cmd;
	p.ip=ip;
	p.startTime=moment();
	p.processID=p.startTime.format('YYYYMMDDTHHmmss-')+p.pid;
	p.info=`${p.protocol}	${p.port}	/${p.route}	"${p.cmd}"	${p.ip}	${p.processID}`;
	openLog(p,p.startTime);
	status(p.info,201,'spawning',p.startTime);
	return p;
}
function cleanup(p,err){
	if(!p.cleaned){
		p.cleaned=true;
		if(err)status(p.info,500,tightJSON('closing due to ERROR: '+err));
		else status(p.info,204,'closing');
		spawnedProcesses.splice(spawnedProcesses.indexOf(p), 1);
		if(p.log){
			// p.log.write(`#End-Date: ${moment().format('YYYY-MM-DD HH:mm:ssZ')}\n`);
			p.log.end();
		}
	}
}
function killSpawnedProcess(p,err){
	if(p){
		cleanup(p,err);
		if(WIN)childProcess.spawn("taskkill", ["/pid", p.pid, '/f', '/t']);
		else p.kill();
	}
}


////////////////////////////////////////
// for ws and tcp
function onTask2ClientMsg(data,socket,taskprocess){
	var arrayOfLines = data.toString().match(/[^\r\n]+/g);
	if(arrayOfLines){
		for(var i=0;i<arrayOfLines.length;i++){
			try{
				if(socket.write)socket.write(arrayOfLines[i]+'\r\n');
				else socket.send(arrayOfLines[i]+'\r\n');
				record2log(taskprocess.log,null,arrayOfLines[i]);
			}catch(e){
				killSpawnedProcess(taskprocess,`!Failed to write to socket:\n > ${arrayOfLines[i]}\n${e}`);
				if(socket.end)socket.end();else socket.close();
			}
		}
	}
}
function onClient2TaskMsg(data,taskprocess){
	try{
		data=data.toString().trim();
		if(data.length){
			taskprocess.stdin.write(data+'\r\n');
			record2log(taskprocess.log,data);
		}
	}catch(e){
		killSpawnedProcess(taskprocess,e);
	}
}
function onClientConnection(task,socket,rcvEvent,endEvent){
	try{
		var taskprocess=setupProcess(task,socket.remoteAddress || socket._socket.remoteAddress);
		taskprocess.stdout.on("data", function(data){onTask2ClientMsg(data,socket,taskprocess);});	// task --> client
		taskprocess.stderr.on("data", function(e){
			killSpawnedProcess(taskprocess,e);
			socket[endEvent]();
		});
		socket.on('error', function(e){
			socket[endEvent]();
			killSpawnedProcess(taskprocess,e);
		});
		socket.on(rcvEvent, function(data){onClient2TaskMsg(data,taskprocess);});					// client --> task
		socket.on(endEvent, function(){killSpawnedProcess(taskprocess);});
		taskprocess.on("close", function(){socket[endEvent]();cleanup(taskprocess);});
	}catch(e){
		killSpawnedProcess(taskprocess,e);
	}
}
function onWSConnection(socket){
	//route via clArgs.ws, then do onClientConnection
	var task=wsServer.routing[socket.upgradeReq.url.slice(1)];
	if(task){onClientConnection(task,socket,'message','close');
	}else socket.close();
}

////////////////////////////////////////
// for http (including jsonp)
function jsonp(callback,data){return `${callback}(${tightJSON(data)})\n`;}
function staticHandler(req,res){
  // maps file extention to MIME typere
  const map = {
    '.ico': 'image/x-icon',
    '.html': 'text/html',
    '.htm': 'text/html',
    '.js': 'text/javascript',
    '.json': 'application/json',
    '.css': 'text/css',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.wav': 'audio/wav',
    '.mp3': 'audio/mpeg',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.doc': 'application/msword'
  };
  // parse URL
  const parsedUrl = url.parse(req.url);
  // extract URL path
  let pathname = path.join(clArgs.root,parsedUrl.pathname);
  function statusline(){
	status(`http	${clArgs.port}	${req.url}	-	${req.connection.remoteAddress}	-`,res.statusCode);
  }
  fs.exists(pathname, function (exist) {
	if(!exist) {
	  // if the file is not found, return 404
	  res.statusCode = 404;
	  res.end(`File ${pathname} not found!`);
	  statusline();
	  return;
	}
    // if is a directory search for index file
    if(fs.statSync(pathname).isDirectory()){
		var pathnameIndex=path.join(pathname,'index.html');
		if(fs.existsSync(pathnameIndex))pathname=pathnameIndex;
		else{
			pathnameIndex=path.join(pathname,'index.htm');
			if(fs.existsSync(pathnameIndex))pathname=pathnameIndex;
			else{
				res.statusCode = 401;
				res.end(`Directory listing not allowed.`);
				statusline();
				return;
			}
		}
	}
	// read file from file system
	fs.readFile(pathname, function(err, data){
		if(err){
			res.statusCode = 500;
			res.end(`Error getting the file: ${err}.`);
		} else {
			// if the file is found, set Content-type and send data
			res.setHeader('Content-type', map[path.parse(pathname).ext] || 'text/plain' );
			res.end(data);
		}
		statusline();
	});
  });
}
function httpHandler(req,res){
	var urlo=url.parse(req.url,true),
		[path,sessionID]=urlo.pathname.slice(1).split(':'),
		task=httpServer.routing[path];
	if(urlo.pathname.indexOf('..')>-1){ //no .. allowed in url for security
		res.statusCode = 404;
		res.end('Invalid URL: '+urlo.pathname);
		return;
	}
	if(task){
		res.setHeader('Content-Type','text/html');
		var params=urlo.query,
			callback=params.callback || params.c;
		if(!sessionID){										//check session-id, create new one if needed
			while((sessionID=(new Date()).getTime()) in httpServer.sessions);
			res.statusCode=302;
			if(callback){
				res.end(jsonp(callback,`http://${req.headers.host}/${path}:${sessionID}${urlo.search}`));
			}else{
				res.end(`<meta http-equiv="refresh" content="0;URL='http://${req.headers.host}/${path}:${sessionID}${urlo.search}'" />`);
			}
			status(`http	${clArgs.port}	${req.url}	${req.connection.remoteAddress}	-`,res.statusCode);
		}else{
			var taskprocess,data;
			if(httpServer.sessions[sessionID]===undefined){	//spawn, create new session
				taskprocess=setupProcess(task,req.connection.remoteAddress);
				httpServer.sessions[sessionID]=taskprocess;
				taskprocess.close=function(){
					killSpawnedProcess(taskprocess);
					delete httpServer.sessions[sessionID];
				}
				taskprocess.stderr.on("data",(e)=>{
					taskprocess.ending=setTimeout(()=>{taskprocess.res.statusCode=500;taskprocess.res.end();},20);
					killSpawnedProcess(taskprocess,e);
					delete httpServer.sessions[sessionID];
				});
				taskprocess.on("close",()=>{
					cleanup(taskprocess);
					delete httpServer.sessions[sessionID];
				});
				taskprocess.stdout.on("data",(data)=>{			//task -> client
					var arrayOfLines = data.toString().match(/[^\r\n]+/g);
					if(arrayOfLines){
						if(taskprocess.ending){
							clearTimeout(taskprocess.ending);
							taskprocess.ending=undefined;
						}
						for(var i=0;i<arrayOfLines.length;i++){
							if(taskprocess.callback)taskprocess.res.write(jsonp(taskprocess.callback,arrayOfLines[i]));
							else taskprocess.res.write(arrayOfLines[i]+'\n');
							record2log(taskprocess.log,null,arrayOfLines[i]);
						}
						taskprocess.ending=setTimeout(()=>{taskprocess.res.end();if(taskprocess.closeWhenDone)taskprocess.close()},20);
					}
				});
			}
			else taskprocess=httpServer.sessions[sessionID];
			//reset user session timeout
			clearTimeout(taskprocess.exitTimeout);
			//store current request data
			taskprocess.callback=callback;
			taskprocess.res=res;
			//process data from client
			if(req.method==='POST'){
				data='';
				req.on('data',(d)=>{data+=d;});
				req.on('end',()=>{
					taskprocess.stdin.write(data+'\r\n');		//client -> task
					record2log(taskprocess.log,data);
				});
			}else{
				data=params.data || params.d || '';
				taskprocess.stdin.write(data+'\r\n');			//client -> task
				record2log(taskprocess.log,data);
			}
			//make sure to respond, even if taskprocess doesn't have anything to say
			taskprocess.ending=setTimeout(()=>{taskprocess.res.end();if(taskprocess.closeWhenDone)taskprocess.close()},200);
			//end session if "end" or "e" is one of the uri params, or set a timer to kill the session after HTTP_CONNECTION_TIMEOUT
			if('e' in params || 'end' in params){
				taskprocess.closeWhenDone=true;
			}else{
				taskprocess.exitTimeout=setTimeout(taskprocess.close,HTTP_CONNECTION_TIMEOUT);
			}
		}
	}else if(clArgs.root){
		staticHandler(req,res);
	}else{
	  res.statusCode = 404;
	  res.end(`File ${urlo.pathname} not found.`);
	}
}

////////////////////////////////////////
// cleanup
function killSpawnedProcesses(){
	for(var i=spawnedProcesses.length-1;i>=0;i--)
		killSpawnedProcess(spawnedProcesses[i]);
}
function exitHandler(options, err) {
	killSpawnedProcesses();
    if(err)status(500,tightJSON(err.stack));
    if(options.exit)process.exit();
	else print('#End-Date: '+moment().format('YYYY-MM-DD HH:mm:ssZ'));
}

////////////////////////////////////////
// parse command-line arguments and launch services
function usageAndExit(err,fullUsage){
	console.log('\n==============================================================================');
	console.log(err);
	console.log('\n==============================================================================\n');
	console.log(fullUsage?USAGE:`- run "servep" without command-line arguments to view usage\n- run "servep --help" to view more detailed documentation`);
	console.log();
	process.exit();
}
function getTask(def,protocol){
	var task={},i=def.indexOf(':'),exe;
	if(i>=0){
		task.route=def.slice(0,i);
		task.cmd=def.slice(i+1);
	}else{
		task.route=path.basename(def);
		task.cmd=def;
	}
	task.args=task.cmd.split(' ');
	exe=clArgs[path.extname(task.args[0]).slice(1)];
	if(exe){
		task.args.unshift(exe);
		task.cmd=exe+' '+task.cmd;
	}
	if(!fs.existsSync(task.args[0]) && !exeExists(task.args[0]))
		usageAndExit(`ERROR: ${task.args[0]} is not a recognized command.`);
	//TODO: if exists, but not executable, throw warning
	task.protocol=protocol;
	if(clArgs.log)makeLogFolder(task);
	return task;
}
function expandFolders(taskLst){
	var i,dirs=taskLst.slice();
	dirs.forEach((dir)=>{
		if(fs.existsSync(dir) && fs.statSync(dir).isDirectory()){
			//add files in dir to taskLst
			fs.readdirSync(dir).forEach((file)=>{
				taskLst.push(path.join(dir,file));
			});
			//remove dir name from taskLst
			i=taskLst.indexOf(dir);
			taskLst.splice(i,1);
		}
	});
}
function main(){
	clArgs=argParser(process.argv.slice(2),{	//parse arguments
			alias:{
				w:'ws',
				t:'tcp',
				h:'http',
				p:'port',
				l:'logpath'
			},
			default:{
				ws:[],http:[],tcp:[],extension:[],port:80
			}
		});
	if(clArgs.help || clArgs.h===true)usageAndExit(DESCRIPTION+HELP,true);
	if(!Array.isArray(clArgs.ws))clArgs.ws=[clArgs.ws];
	if(!Array.isArray(clArgs.tcp))clArgs.tcp=[clArgs.tcp];
	if(!Array.isArray(clArgs.http))clArgs.http=[clArgs.http];
	clArgs.root=clArgs._[0];
	if(!clArgs.root && !clArgs.ws.length && !clArgs.tcp.length && !clArgs.http.length)usageAndExit(DESCRIPTION,true);
	print('#Version: 1.1');
	print(`#Date: ${moment().format('YYYY-MM-DD HH:mm:ssZ')}`);
	print('#Fields: s-date s-time cs-protocol s-port cs-uri x-command c-ip x-processid s-status s-comment');
	print('#Remark: Starting services...');
	if(clArgs.root){						//serve entire folder (everything not in WS_FOLDER or HTTP_FOLDER is served as static files)
		if(!fs.existsSync(clArgs.root) || !fs.statSync(clArgs.root).isDirectory())
			usageAndExit(`ERROR: ${clArgs.root} is not a valid path.`);
		let subfolder=path.join(clArgs.root,WS_FOLDER);
		if(fs.existsSync(subfolder) && fs.statSync(subfolder).isDirectory())
			clArgs.ws.push(subfolder);
		subfolder=path.join(clArgs.root,HTTP_FOLDER);
		if(fs.existsSync(subfolder) && fs.statSync(subfolder).isDirectory())
			clArgs.http.push(subfolder);
		status(`http ${clArgs.port}	/	-	-	-`,0,'ready');
	}
	if(clArgs.root || clArgs.http.length){	//serve processes over http
		httpServer=Http.createServer(httpHandler);
		httpServer.listen(clArgs.port);
		httpServer.on('error',(e)=>{usageAndExit(`ERROR: Could not start server on port ${clArgs.port}.\n - maybe port ${clArgs.port} is in use or disallowed?`)});
		httpServer.sessions={};
		httpServer.routing={};
		expandFolders(clArgs.http);
		clArgs.http.forEach((s)=>{
			let task=getTask(s,'http');
			if(task.route in httpServer.routing)usageAndExit(`ERROR: Duplicate HTTP service name: ${task.route}`);
			httpServer.routing[task.route]=task;
			status(`http ${clArgs.port}	/${task.route}	"${task.cmd}"	-	-`,0,'ready');
		});
	}
	if(clArgs.ws.length){					//serve processes over websockets
		wsServer = new WebSocket.Server(httpServer?{server:httpServer}:{port:clArgs.port});
		wsServer.on('error',(e)=>{usageAndExit(`ERROR: Could not start WS server on port ${clArgs.port}.\n - maybe port ${clArgs.port} is in use or disallowed?`)});
		wsServer.on('connection', onWSConnection);
		wsServer.routing={};
		expandFolders(clArgs.ws);
		clArgs.ws.forEach((s)=>{
			let task=getTask(s,'ws');
			if(task.route in wsServer.routing)usageAndExit(`ERROR: Duplicate WS service name: ${task.route}`);
			wsServer.routing[task.route]=task;
			status(`ws	${clArgs.port}	/${task.route}	"${task.cmd}"	-	-`,0,'ready');
		});
	}
	if(clArgs.tcp.length){				//serve processes over tcp
		expandFolders(clArgs.tcp);
		if(tcpPort==clArgs.port)++tcpPort;
		clArgs.tcp.forEach((s)=>{
			let task=getTask(s,'tcp');
			task.port=parseInt(task.route) || tcpPort;
			if(tcpPort==task.port)++tcpPort;
			var tcpServer=CreateTcpServer((socket)=>{onClientConnection(task,socket,'data','end')}).listen(task.port);
			tcpServer.on('error',(e)=>{usageAndExit(`ERROR: Could not start service for ${task.cmd} started on TCP port ${task.route}.\n - maybe port ${task.route} is in use or disallowed?`)});
			status(`tcp	${task.port}	-	"${task.cmd}"	-	-`,0,'ready');
		});
	}else if(!clArgs.http.length && !clArgs.ws.length)
		usageAndExit('No valid services were specified.');
	//starts handler on exit
	process.on('exit', exitHandler.bind(null));
	//catch ctrl+c event
	process.on('SIGINT', exitHandler.bind(null, {exit:true}));
	print(`#Remark:  All services running.  Hit Ctrl+C to quit.`)
}


if(require.main === module)main();
