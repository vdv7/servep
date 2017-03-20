    This script serves stdio executables over TCP, HTTP, or WebSockets.

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
        adding GET parameter e or GET parameter end to an HTTP request
		  gracefully ends the current session

        example of simple echo process interaction:

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



    Using this script requires that you have node.js installed
      (see https://nodejs.org)

    Try out the service on the sample scripts folder:
      node servep.js samples/

    Install script via npm: npm install -g servep
      (you may need to precede the previous line with "sudo" on linux)

    Run after npm installation:
      servep [ServeFolder] [Options]

    Get usage:
      servep

    Get more detailed help:
      servep --help
