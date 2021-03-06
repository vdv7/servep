#!/usr/bin/env node

////////////////////////////////////
// Process Server
//	this script will serve standard console processes over a standard TCP socket, a websocket connection, or via a stateful http session
//
//


const
	WS_FOLDER = '_ws',
	HTTP_FOLDER = '_http',
	HTTP_CONNECTION_TIMEOUT = 600000, //10min
	AUTO_TCP_PORT = 9000
;


////////////////////////////////////////
// usage and help
const DESCRIPTION="This script serves stdio executables over TCP, HTTP, or WebSockets.";
const USAGE=`Usage: servep Options

  Options:
    --help                   help text with usage and description
	-s, --static Folder      serve static files located in Folder
    -p, --port PORT          serve http/ws processes and static files on PORT;
                             if this argument is not specified, default is 80
    -t, --tcp [TcpExe]+      serve TcpExe processes over TCP (no headers)
    -w, --ws [WsExe]+        serve WsExe processes over websockets
    -h, --http [HttpExe]+    serve HttpExe processes over http
    -l, --log path           log all server-client interactions in separate
                               files in the specified path, under subfolder
                               PROTOCOL/ROUTE/, where PROTOCOL is http, ws, or
                               tcp, and ROUTE is the respective Port or Name
    -n, --nolog [ROUTE]+     do not log server-client interactions for ROUTE;
                               ROUTE is Port or Name of one of the services
    -e, --extexe EXT EXE     indicates that paths with extension EXT are
                               scripts that require specific EXE to run
                               (this argument may be specified multiple times)
                               Ex: servep -h myFolder -e py python3 -e js node
  TcpExe:
    Folder                   serve all executables in Folder over TCP
                               (auto-generated ports)
    Path                     serve executable at Path over TCP
                               (auto-generated port)
    "Port::Path"             serve executable at Path on specified TCP Port
  WsExe:
    Folder                   serve all executables in Folder via WebSockets
                               (auto-generated URL)
    Path                     serve executable at Path via WebSockets
                               (auto-generated URL)
    "Name::Path"             serve executable at Path via Websockets,
                               Name specifies the URL path
                               Ex: servep -w "hello::helloworld.py" will
                                serve helloworld.py at ws://server:port/hello
  HttpExe:
    Folder                   serve all executables in Folder via stateful HTTP
                               (auto-generated URL)
    Path                     serve executable at Path via stateful HTTP
                               (auto-generated URL)
    "Name::Path"             serve executable at Path via stateful HTTP,
                               Name specifies the URL path
                               Ex: servep -h "yo::helloworld.py" will
                                serve helloworld.py at http://server:port/yo
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

          client GET request:
            http://localhost:8000/myapp
          server responds with a status code of 302 and the following body:
            http://localhost:8000/myapp:xxx
              (where xxx is the session id)
          client GET request:
            http://localhost:8000/myapp:xxx?d=hello
          server response body:
            foo("you said: hello")
          client GET request: http://localhost:8000/myapp:xxx?e
          server closes the running echo process and responds with status 204


Examples:
  servep -p 8000 --http "hi::echo hi" --ws "hi::echo hi" --tcp "9001::echo hi"
  (will serve process "echo hi" at http://localhost:8000/hi, 
    ws://localhost:8000/hi, and over tcp without any headers on port 9001)

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
	ArgumentParser = require('argparse').ArgumentParser,
	fs=require('fs'),
	path=require('path'),
	url = require('url'),
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
	return p.status===0?p.stdout.toString().trim():false;
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
	if(clArgs.log && (clArgs.nolog.indexOf(taskprocess.route)<0)){
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
  let pathname = path.join(clArgs.static,parsedUrl.pathname);
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
		res.setHeader('Access-Control-Allow-Origin','*');
		var params=urlo.query,
			callback=params.callback || params.c;
		if(!sessionID){										//check session-id, create new one if needed
			while((sessionID=(new Date()).getTime()) in httpServer.sessions);
			res.statusCode=201;
			if(callback){
				res.end(jsonp(callback,`http://${req.headers.host}/${path}:${sessionID}${urlo.search||''}`));
			}else{
				res.end(`http://${req.headers.host}/${path}:${sessionID}${urlo.search||''}`);
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
							if(taskprocess.callback){
								taskprocess.res.write(jsonp(taskprocess.callback,arrayOfLines[i]));
							}else{
								taskprocess.res.write(arrayOfLines[i]+'\n');
							}
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
	}else if(clArgs.static){
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
	var task={},i=def.indexOf('::'),exe;
	if(i>=0){
		task.route=def.slice(0,i);
		task.cmd=def.slice(i+2);
	}else{
		task.route=path.basename(def);
		task.cmd=def;
	}
	task.args=task.cmd.split(' ');
	exe=clArgs.extexe[path.extname(task.args[0]).slice(1)];
	if(exe){
		task.args.unshift(exe);
		task.cmd=exe+' '+task.cmd;
	}
	var existsLocal=fs.existsSync(task.args[0]);
	var existsPath=exeExists(task.args[0]);
	if(!existsLocal && !existsPath)
		usageAndExit(`ERROR: ${task.args[0]} is not a recognized command.`);
	try{
		fs.accessSync(existsLocal?task.args[0]:existsPath, fs.constants.X_OK);
	}catch(e){
		usageAndExit(`ERROR: ${task.args[0]} is not executable.`);
	}
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
	//parse arguments
	argParser=new ArgumentParser({
		addHelp:false,
		argumentDefault:[]
	});
	argParser.addArgument(['-w','--ws'],{nargs:'*'});
	argParser.addArgument(['-t','--tcp'],{nargs:'*'});
	argParser.addArgument(['-h','--http'],{nargs:'*'});
	argParser.addArgument(['-s','--static'],{defaultValue:null});
	argParser.addArgument(['-l','--log','--logpath'],{defaultValue:null});
	argParser.addArgument(['-n','--nolog'],{nargs:'*'});
	argParser.addArgument(['-p','--port'],{defaultValue:8000});
	argParser.addArgument(['-e','--extexe'],{nargs:2,action:'append'});
	argParser.addArgument(['--help'],{nargs:0,defaultValue:null});
	clArgs=argParser.parseArgs(process.argv.slice(2));
	//display help
	if(clArgs.help)usageAndExit(DESCRIPTION+HELP,true);
	//turn extexe argument into Object
	clArgs.extexe=clArgs.extexe.reduce((p,c)=>{p[c[0]]=c[1];return p;},{});
	if(!clArgs.static && !clArgs.ws.length && !clArgs.tcp.length && !clArgs.http.length)usageAndExit(DESCRIPTION,true);
	print('#Version: 1.1');
	print(`#Date: ${moment().format('YYYY-MM-DD HH:mm:ssZ')}`);
	print('#Fields: s-date s-time cs-protocol s-port cs-uri x-command c-ip x-processid s-status s-comment');
	print('#Remark: Starting services...');
	if(clArgs.static && (!fs.existsSync(clArgs.static) || !fs.statSync(clArgs.static).isDirectory()))
		usageAndExit(`ERROR: ${clArgs.static} is not a valid folder path.`);
	if(clArgs.static || clArgs.http.length){	//serve processes over http
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
			task.port=isNaN(task.route)?tcpPort:parseInt(task.route);
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
