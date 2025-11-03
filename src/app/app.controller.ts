import { Controller, Get, HttpStatus } from '@nestjs/common';
import { AppService } from './app.service';
import { MessagePattern } from '@nestjs/microservices';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @MessagePattern('health')
  async healthCheck() {
    return {
      statusCode: HttpStatus.OK,
      assistantMessage: 'Assistant service is working fine...',
    };
  }

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }
}
