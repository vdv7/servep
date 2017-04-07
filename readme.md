    This script serves stdio executables over TCP, HTTP, or WebSockets.
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
