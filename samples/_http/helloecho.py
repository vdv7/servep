#!/usr/bin/env python3

'''stdio echo (waits for user input to start)'''

input()
print('Hello World!', flush=True)

while 1:
	print('you said: '+input(), flush=True)

