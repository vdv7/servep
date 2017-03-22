#!/usr/bin/env node

////////////////////////////////////
// Process Server
//	this script will serve a standard console process over a standard TCP socket or a websocket connection;
//	each new connection will spawn a new console process;
//  each flushed string from a console process will be redirected to the corresponding client, and can be logged;
//  best practice is to flush console process output after each newline
//
//
// TODO:
//	before next commit:
//		add into help/readme that tcp port does not need to be specified, and that whole folders can be
//	allow changes in HTTP_CONNECTION_TIMEOUT, auto-tcp port range, and timeout for res.end via cli
//	add ability to assign a prefix to all scripts in a folder (e.g. python tasks/stdio)
//	add help documentation (e.g. example interactions over netcat, curl, and wscat, requirement to flush, CDE protocol, session-id redirects, log format, only 3 http req's per processID, etc) 
//	copy help documentation into readme
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
const USAGE=`Usage: servep [ServeFolder] [Options]

  ServeFolder:              path to a folder optionally containing
                              - static files to serve over http (e.g. html)
                              - ${HTTP_FOLDER}/ folder containing executables 
                                to be served over http
                              - ${WS_FOLDER}/ folder containing executables
                                to be served over ws
  Options:
    --help                  more detailed help text
    -p, --port PORT         serve http/ws processes and static files on PORT;
                            if this argument is not specified, default is 80
    -t, --tcp ExeFolder     serve processes in ExeFolder over TCP
    -t, --tcp "Port:Exe"    serve Exe over TCP, on a specified Port
                            (this argument may be specified multiple times)
    -w, --ws ExeFolder      serve processes in ExeFolder over websockets
    -w, --ws "Name:Exe"     serve Exe over websockets, route by specified Name
                            (this argument may be specified multiple times)
    -h, --http ExeFolder    serve processes in ExeFolder over http
    -h, --http "Name:Exe"   serve Exe over http, route by specified Name
    -l, --log path          log all server-client interactions in separate
                              files in the specified path, under subfolder
                              PROTOCOL/ROUTE/, where PROTOCOL is http, ws, or
                              tcp, and ROUTE is the respective Port or Name
  ExeFolder                 path to folder including executable processes
  Exe                       path to executable process [and arguments], or
`;
const HELP=`
Each new TCP or WS connection to server will spawn a new process, and pipe
socket-out to std-in, and std-out to socket-in.

HTTP requests without a session-id are redirected, so as to include unique
session-id. Each new session-id is tied to a newly spawned process. Each 
HTTP request with a session-id is stripped of headers and routed to its
respective process std-in. HTTP response is generated from process std-out.

  HTTP requests adhere to the CDE (callback/data/end) protocol, i.e.:

	JSONP requests are enabled by adding GET parameter *callback* or GET
	  parameter *c* 
	all input to server-side process is passed as GET
	  parameter *d*, GET parameter *data*, or in POST method body
	adding GET parameter *e* or GET parameter *end* to an HTTP request
	  gracefully ends the current session

	example of simple HTTP echo process interaction:

	  client GET request: http://localhost:8000/myapp?c=process&d=hello
	  server response body: http://localhost:8000/myapp:xxx?c=process&d=hi
		(where xxx is the session id)
	  client GET request: http://localhost:8000/myapp:xxx?c=process&d=hi
	  server response body: "you said: hello"
	  client GET request: http://localhost:8000/myapp:xxx?e
	  server closes the running echo process and responds with status 204


Example:
  servep -p 8000 --http "hi:echo hi" --ws "hi:echo hi" --tcp "8001:echo hi"
  (will serve process "echo hi" at http://localhost:8000/hi, 
	ws://localhost:8000/hi, and on tcp without any headers on port 8001)


Log formatting adheres to the Extended Log File Format (ELF), version 1.1.
  ELF version 1.0 is specified here: https://www.w3.org/TR/WD-logfile.html
  In addition to ELF 1.0 fields, 1.1 allows the following fields:
    Field names that require no prefix:
      epochs, epochms,        seconds and milliseconds since epoch
    Field names that require sc-, cs-, s-, or c- prefix:
      port,                   server port
      protocol                connection protocol (e.g. http, https, ws)
      raw, raw,               all data coming over the wire, including headers
      head, head,             entire string of headers
      body, body,             data coming over the wire, minus the headers
    Fields date and time did not used to allow prefix, but now allow s- or c-:
      s-date, s-time,         local date/time on server
      c-date, c-time,         local date/time on client
  In addition to ELF 1.0 time definition, 1.1 allows time-zone offset:
    <time>=2<digit>":"2<digit>[":"2<digit>["."*<digit>]]["+"|"-"2<digit>[":"2<digit>]]');
  In addition to ELF 1.0 value types, 1.1 allows *tight JSON strings.
    *tight JSON: JSON without any optional whitespace
  Example of ELF v1.1:
    #Version: 1.1
    #Date: 2017-03-17 13:20:58-04:00
    #Fields: s-date s-time cs-protocol s-port uri sc-body
    2017-03-17 13:21:05 http 80 / "<html><body>\nHello World!\n</body></html>"
    2017-03-17 13:21:13 http 80 /somescript.py {"x":"Hello World!\nLook, double-quotes: \"","y":23,"z":true}
    2017-03-17 13:21:15 http 80 /somescript.py {"x":"Goodbye World."}
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
function datetime(){var a=moment().format('YYYY-MM-DD HH:mm:ss.SSSZ');return a.endsWith(':00')?a.substring(0,26):a;}
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
	print(`${(now||moment()).format('YYYY-MM-DD HH:mm:ss')}\t${taskinfo}\t${status||'-'}\t${comment || '-'}`);
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
	cleanup(p,err);
	if(WIN)childProcess.spawn("taskkill", ["/pid", p.pid, '/f', '/t']);
	else p.kill();
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
					taskprocess.ending=setTimeout(()=>{taskprocess.res.end();},20);
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
//starts handler on exit
process.on('exit', exitHandler.bind(null));
//catch ctrl+c event
process.on('SIGINT', exitHandler.bind(null, {exit:true}));

////////////////////////////////////////
// parse command-line arguments and launch services
function usageAndExit(err){
	console.log('\n==============================================================================');
	console.log(err);
	console.log('\n==============================================================================\n');
	console.log(USAGE);
	process.exit();
}
function getTask(def,protocol){
	var task={},i=def.indexOf(':');
	if(i>=0){
		task.route=def.slice(0,i);
		task.cmd=def.slice(i+1);
	}else{
		task.route=path.basename(def);
		task.cmd=def;
	}
	task.args=task.cmd.split(' ');
	if(!exeExists(task.args[0]))
		usageAndExit(`ERROR: ${task.args[0]} is not a recognized command.`);
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
				l:'log'
			},
			default:{
				ws:[],http:[],tcp:[],port:80
			}
		});
	if(clArgs.help || clArgs.h===true)usageAndExit(DESCRIPTION+HELP);
	if(!Array.isArray(clArgs.ws))clArgs.ws=[clArgs.ws];
	if(!Array.isArray(clArgs.tcp))clArgs.tcp=[clArgs.tcp];
	if(!Array.isArray(clArgs.http))clArgs.http=[clArgs.http];
	clArgs.root=clArgs._[0];
	if(!clArgs.root && !clArgs.ws.length && !clArgs.tcp.length && !clArgs.http.length)usageAndExit(DESCRIPTION);
	print('#Version: 1.1');
	// print('#Remark: in addition to Extended Log File Format 1.0 fields, 1.1 allows the following fields: s-date,s-time,c-date,c-time,epochs,epochms,protocol,port');
	// print('#Remark: in addition to Extended Log File Format 1.0 time definition, 1.1 allows time-zone offset specification: <time> = 2<digit> ":" 2<digit> [":" 2<digit> ["." *<digit>]] ["+"|"-" 2<digit> [":" 2<digit>]]');
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
	}
	print(`#Remark:  All services running.  Hit Ctrl+C to quit.`)
}


if(require.main === module)main();
